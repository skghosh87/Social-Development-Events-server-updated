const express = require("express");
const cors = require("cors");
require("dotenv").config();
const jwt = require("jsonwebtoken");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

/* =======================
    Middleware
======================= */
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://socialdevelopmenteventproject.netlify.app",
    ],
    credentials: true,
  }),
);
app.use(express.json());

/* =======================
    MongoDB Connection
======================= */
const uri = `mongodb+srv://${process.env.DB_UserName}:${process.env.DB_Password}@skghosh.wrzjkjg.mongodb.net/?appName=Skghosh`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

/* =======================
    Custom Middlewares
======================= */
const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader)
    return res.status(401).send({ message: "Unauthorized access" });

  const token = authHeader.split(" ")[1];

  try {
    jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
      if (err) {
        return res.status(403).send({ message: "Forbidden access" });
      }
      req.decoded = decoded;
      next();
    });
  } catch (error) {
    res
      .status(500)
      .send({ message: "Internal server error during token verification" });
  }
};

async function run() {
  try {
    const database = client.db("socialdevelopmentevent");
    const usersCollection = database.collection("users");
    const eventsCollection = database.collection("events");
    const joinedEventsCollection = database.collection("joinedEvents");

    // Admin Verification Middleware
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const user = await usersCollection.findOne({ email });
      if (user?.role !== "admin") {
        return res
          .status(403)
          .send({ message: "Forbidden: Admin access only" });
      }
      next();
    };

    /* =======================
        AUTH / JWT
    ======================= */
    app.post("/api/jwt", async (req, res) => {
      const { email } = req.body;
      const token = jwt.sign({ email }, process.env.ACCESS_TOKEN_SECRET, {
        // expiresIn: "7d",
      });
      res.send({ token });
    });

    /* =======================
        USERS API
    ======================= */
    app.post("/api/users", async (req, res) => {
      const user = req.body;
      const exists = await usersCollection.findOne({ email: user.email });
      if (exists)
        return res.send({ message: "User already exists", insertedId: null });

      const result = await usersCollection.insertOne({
        ...user,
        role: "user",
        status: "active",
        createdAt: new Date(),
      });
      res.send(result);
    });

    app.get("/api/users", verifyToken, verifyAdmin, async (req, res) => {
      const result = await usersCollection.find().toArray();
      res.send(result);
    });

    app.get("/api/users/role/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      if (email !== req.decoded.email)
        return res.status(403).send({ message: "Forbidden" });
      const user = await usersCollection.findOne({ email });
      res.send({ admin: user?.role === "admin", status: user?.status });
    });

    app.patch(
      "/api/users/status/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const { status, role } = req.body;
        const filter = { _id: new ObjectId(id) };

        // ১. আপডেট ডকুমেন্ট তৈরি
        const updateDoc = { $set: {} };
        if (status) updateDoc.$set.status = status;
        if (role) updateDoc.$set.role = role;

        // ২. ডাটাবেস আপডেট
        const result = await usersCollection.updateOne(filter, updateDoc);
        res.send(result);
      },
    );

    /* =======================
        STRIPE PAYMENT
    ======================= */
    app.post("/api/create-payment-intent", verifyToken, async (req, res) => {
      const { price } = req.body;
      const amount = parseInt(price * 100);
      if (!amount || amount < 1)
        return res.status(400).send({ message: "Invalid amount" });

      const paymentIntent = await stripe.paymentIntents.create({
        amount: amount,
        currency: "usd",
        payment_method_types: ["card"],
      });

      res.send({ clientSecret: paymentIntent.client_secret });
    });

    /* =======================
        EVENTS API
    ======================= */

    // ১. সকল একটিভ ইভেন্ট (Upcoming)
    app.get("/api/events/upcoming", async (req, res) => {
      const { search, category } = req.query;
      try {
        let query = { status: "active" };
        if (search) query.eventName = { $regex: search, $options: "i" };
        if (category && category !== "" && category !== "All")
          query.category = category;

        const events = await eventsCollection
          .find(query)
          .sort({ eventDate: 1 })
          .toArray();
        res.send(events);
      } catch (error) {
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    // ২. ইভেন্ট ম্যানেজ
    app.get("/api/events/manage/:email", verifyToken, async (req, res) => {
      try {
        const email = req.params.email;
        if (email !== req.decoded.email)
          return res.status(403).send({ message: "Forbidden" });

        const user = await usersCollection.findOne({ email });
        let query = {};
        if (user?.role !== "admin") {
          query = { organizerEmail: email };
        }

        const result = await eventsCollection.find(query).toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Error fetching management events" });
      }
    });

    // ৩. নির্দিষ্ট ইভেন্ট ডিটেইলস
    app.get("/api/events/:id", async (req, res) => {
      const id = req.params.id;
      if (!ObjectId.isValid(id))
        return res.status(400).send({ message: "Invalid ID format" });

      try {
        const result = await eventsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!result)
          return res.status(404).send({ message: "Event not found" });
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Server error" });
      }
    });

    // ৪. ইভেন্ট তৈরি করা
    app.post("/api/events", verifyToken, async (req, res) => {
      const email = req.decoded.email;
      const user = await usersCollection.findOne({ email });

      if (user.status !== "active")
        return res.status(403).send({ message: "Account suspended" });

      const eventData = {
        ...req.body,
        organizerEmail: email,
        participants: 1,
        status: "active",
        postedAt: new Date(),
      };

      const result = await eventsCollection.insertOne(eventData);

      await joinedEventsCollection.insertOne({
        eventId: result.insertedId.toString(),
        eventName: req.body.eventName,
        userEmail: email,
        userName: user.name || user.displayName,
        amount:
          user.role === "admin"
            ? 0
            : Number(req.body.organizerContribution || 0),
        transactionId: "organizer_auto_join",
        joinedDate: new Date(),
      });

      res.send(result);
    });

    // ৫. ইভেন্ট আপডেট করা
    app.patch("/api/events/:id", verifyToken, async (req, res) => {
      try {
        const id = req.params.id;
        const userEmail = req.decoded.email;
        const userRole = req.decoded.role;

        const filter = { _id: new ObjectId(id) };

        let query = filter;
        if (userRole !== "admin") {
          query = {
            _id: new ObjectId(id),
            organizerEmail: userEmail,
          };
        }

        const updateData = { ...req.body };
        delete updateData._id;

        const updatedDoc = { $set: updateData };
        const result = await eventsCollection.updateOne(query, updatedDoc);

        if (result.matchedCount === 0) {
          return res.status(403).send({
            message: "আপনি এই ইভেন্টটি আপডেট করার অনুমতিপ্রাপ্ত নন!",
          });
        }

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "সার্ভার এরর!" });
      }
    });

    // ৬. ইভেন্ট ডিলিট করা (অ্যাডমিন এবং অর্গানাইজার উভয়ই পারবে)
    app.delete("/api/events/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const email = req.decoded.email;
      const user = await usersCollection.findOne({ email });

      let query = { _id: new ObjectId(id) };
      if (user?.role !== "admin") {
        query.organizerEmail = email;
      }

      const result = await eventsCollection.deleteOne(query);
      res.send(result);
    });

    /* =======================
        JOIN EVENT API
    ======================= */
    app.post("/api/join-event", verifyToken, async (req, res) => {
      const { eventId, eventName, amount, transactionId } = req.body;
      const email = req.decoded.email;

      const alreadyJoined = await joinedEventsCollection.findOne({
        userEmail: email,
        eventId: eventId,
      });

      if (alreadyJoined)
        return res.status(400).send({ message: "Already joined" });

      const user = await usersCollection.findOne({ email });
      const joinDoc = {
        eventId,
        eventName,
        userEmail: email,
        userName: user?.name || user?.displayName || "User",
        amount: Number(amount),
        transactionId,
        joinedDate: new Date(),
      };

      const result = await joinedEventsCollection.insertOne(joinDoc);
      await eventsCollection.updateOne(
        { _id: new ObjectId(eventId) },
        { $inc: { participants: 1 } },
      );
      res.send(result);
    });

    app.get("/api/joined-events/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      if (email !== req.decoded.email)
        return res.status(403).send({ message: "Forbidden" });

      try {
        const userJoins = await joinedEventsCollection
          .find({ userEmail: email })
          .toArray();
        const eventIds = userJoins.map((item) => new ObjectId(item.eventId));
        const eventDetails = await eventsCollection
          .find({ _id: { $in: eventIds } })
          .toArray();

        const result = userJoins.map((join) => {
          const detail = eventDetails.find(
            (d) => d._id.toString() === join.eventId,
          );
          return {
            ...join,
            ...detail,
            _id: join._id,
            eventMainId: detail?._id,
          };
        });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Error fetching joined events" });
      }
    });
    app.get("/api/recent-joins", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const result = await joinedEventsCollection
          .find()
          .sort({ joinedDate: -1 })
          .limit(5)
          .toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Error fetching recent joins" });
      }
    });
    app.get(
      "/api/all-joined-events",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const result = await joinedEventsCollection
            .find()
            .sort({ joinedDate: -1 })
            .toArray();
          res.send(result);
        } catch (error) {
          res.status(500).send({ message: "ডেটা আনতে সমস্যা হয়েছে।" });
        }
      },
    );
    /* =======================
        ADMIN STATS
    ======================= */
    app.get("/api/admin-stats", verifyToken, verifyAdmin, async (req, res) => {
      const totalEvents = await eventsCollection.countDocuments();
      const totalUsers = await usersCollection.countDocuments();
      const totalJoined = await joinedEventsCollection.countDocuments();
      const revenue = await joinedEventsCollection
        .aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }])
        .toArray();

      const categoryStats = await eventsCollection
        .aggregate([
          { $group: { _id: "$category", value: { $sum: 1 } } },
          { $project: { name: "$_id", value: 1, _id: 0 } },
        ])
        .toArray();

      res.send({
        totalEvents,
        totalUsers,
        totalJoined,
        totalEarnings: revenue[0]?.total || 0,
        categoryData: categoryStats,
      });
    });

    /* =======================
        ADMIN Donation STATS
    ======================= */
    // ১. সকল ডোনেশন গেট করার এপিআই (Admin Only)
    app.get("/api/donations", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const result = await joinedEventsCollection
          .find()
          .sort({ joinedDate: -1 })
          .toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "ডোনেশন ডাটা আনতে সমস্যা হয়েছে।" });
      }
    });

    // ২. ডোনেশন স্ট্যাটাস আপডেট করার এপিআই (Pending to Success)
    app.patch(
      "/api/donations/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const id = req.params.id;
          const filter = { _id: new ObjectId(id) };
          const updatedDoc = {
            $set: {
              status: req.body.status, // যেমন: "Success" বা "Verified"
            },
          };
          const result = await joinedEventsCollection.updateOne(
            filter,
            updatedDoc,
          );
          res.send(result);
        } catch (error) {
          res.status(500).send({ message: "স্ট্যাটাস আপডেট ব্যর্থ হয়েছে।" });
        }
      },
    );
    // ৩. কোনো ডোনেশন রেকর্ড ডিলিট করার এপিআই
    app.delete(
      "/api/donations/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const id = req.params.id;
          const query = { _id: new ObjectId(id) };
          const result = await joinedEventsCollection.deleteOne(query);
          res.send(result);
        } catch (error) {
          res.status(500).send({ message: "রেকর্ড ডিলিট করা যায়নি।" });
        }
      },
    );
    console.log("💎 MongoDB Connected Successfully!");
  } finally {
  }
}
run().catch(console.dir);

app.get("/", (req, res) => res.send("SDEP Server is running..."));
app.listen(port, () => console.log(`Server is on port ${port}`));
