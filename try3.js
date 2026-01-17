const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

/* =======================
    Middleware
======================= */
app.use(cors());
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

async function run() {
  try {
    const database = client.db("socialdevelopmentevent");

    const eventsCollection = database.collection("events");
    const joinedEventsCollection = database.collection("joinedEvents");
    const usersCollection = database.collection("users");

    /* =======================
        USERS API
    ======================= */

    // Create/insert User
    app.post("/api/users", async (req, res) => {
      const user = req.body;
      const existingUser = await usersCollection.findOne({ email: user.email });

      if (existingUser) {
        return res.send({ message: "User already exists" });
      }

      const result = await usersCollection.insertOne({
        ...user,
        role: "user",
        status: "active",
        createdAt: new Date().toISOString(),
      });
      res.send(result);
    });

    // Get User Role & Status
    app.get("/api/users/role/:email", async (req, res) => {
      const user = await usersCollection.findOne({ email: req.params.email });
      res.send({
        role: user?.role || "user",
        status: user?.status || "active",
      });
    });

    // All Users (Admin View)
    app.get("/api/users", async (req, res) => {
      const users = await usersCollection.find().toArray();
      res.send(users);
    });

    // Update User Status (Admin only: active/suspended)
    app.patch("/api/users/status/:id", async (req, res) => {
      const result = await usersCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { status: req.body.status } }
      );
      res.send(result);
    });

    /* =======================
        EVENTS API
    ======================= */

    // Create Event (Handled for both Admin and User)
    app.post("/api/events", async (req, res) => {
      const eventData = req.body;
      const event = {
        ...eventData,
        participants: 0,
        status: "active",
        postedAt: new Date().toISOString(),
      };

      const result = await eventsCollection.insertOne(event);
      res.send({ success: true, insertedId: result.insertedId });
    });

    // Upcoming Events with Filter & Search
    app.get("/api/events/upcoming", async (req, res) => {
      const { category, search } = req.query;
      let query = {
        eventDate: { $gte: new Date().toISOString() },
        status: "active",
      };

      if (category && category !== "all") query.category = category;
      if (search) query.eventName = { $regex: search, $options: "i" };

      const events = await eventsCollection
        .find(query)
        .sort({ eventDate: 1 })
        .toArray();
      res.send({ success: true, events });
    });

    // All Events (Admin Management)
    app.get("/api/all-events-admin", async (req, res) => {
      const events = await eventsCollection
        .find()
        .sort({ postedAt: -1 })
        .toArray();
      res.send(events);
    });

    // Single Event Details
    app.get("/api/events/:id", async (req, res) => {
      const event = await eventsCollection.findOne({
        _id: new ObjectId(req.params.id),
      });
      res.send({ success: true, event });
    });

    // Organizer/User's specific events
    app.get("/api/events/organizer/:email", async (req, res) => {
      const events = await eventsCollection
        .find({ organizerEmail: req.params.email })
        .toArray();
      res.send({ success: true, events });
    });

    // Update Event (Admin can edit any, User only theirs)
    app.put("/api/events/:id", async (req, res) => {
      const id = req.params.id;
      const { organizerEmail, userRole, ...updateFields } = req.body;

      let query = { _id: new ObjectId(id) };
      // যদি অ্যাডমিন না হয়, তবে নিজের ইভেন্ট কিনা চেক করবে
      if (userRole !== "admin") {
        query.organizerEmail = organizerEmail;
      }

      const result = await eventsCollection.updateOne(query, {
        $set: updateFields,
      });
      if (result.matchedCount === 0)
        return res.status(403).send({ message: "Unauthorized" });
      res.send({ success: true });
    });

    // Delete Event (Admin power included)
    app.delete("/api/events/:id", async (req, res) => {
      const { organizerEmail, userRole } = req.query;

      let query = { _id: new ObjectId(req.params.id) };
      if (userRole !== "admin") {
        query.organizerEmail = organizerEmail;
      }

      const result = await eventsCollection.deleteOne(query);
      if (result.deletedCount > 0) {
        await joinedEventsCollection.deleteMany({ eventId: req.params.id });
      }
      res.send({ success: true, deletedCount: result.deletedCount });
    });

    /* =======================
        JOINING & PAYMENTS
    ======================= */

    // Join Event Logic
    app.post("/api/join-event", async (req, res) => {
      const { eventId, userEmail, userName, amount, transactionId } = req.body;

      const exists = await joinedEventsCollection.findOne({
        eventId,
        userEmail,
      });
      if (exists) return res.status(409).send({ message: "Already joined" });

      const joinInfo = {
        eventId,
        userEmail,
        userName,
        amount: parseFloat(amount) || 0,
        transactionId: transactionId || "free/admin",
        joinedDate: new Date().toISOString(),
      };

      await joinedEventsCollection.insertOne(joinInfo);
      await eventsCollection.updateOne(
        { _id: new ObjectId(eventId) },
        { $inc: { participants: 1 } }
      );

      res.send({ success: true });
    });
    // ইউজারের জয়েন করা ইভেন্টগুলোর লিস্ট পাওয়ার জন্য
    app.get("/api/joined-events/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const result = await joinedEventsCollection
          .find({ userEmail: email })
          .toArray();

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Error fetching joined events" });
      }
    });
    // joined-events/check API
    app.get("/api/joined-events/check", async (req, res) => {
      try {
        const { eventId, email } = req.query;

        // ডাটাবেজে চেক করুন ফিল্ডের নাম 'eventId' এবং 'userEmail' আছে কি না
        const exists = await joinedEventsCollection.findOne({
          eventId: eventId,
          userEmail: email,
        });

        // রেজাল্টটি পরিষ্কারভাবে পাঠান
        res.send({ isJoined: !!exists });
      } catch (error) {
        res.status(500).send({ message: "Error" });
      }
    });
    // Stripe Payment Intent
    app.post("/api/create-payment-intent", async (req, res) => {
      const { price } = req.body;
      if (!price || price < 1)
        return res.status(400).send({ message: "Invalid amount" });

      const amount = Math.round(price * 100);
      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: "usd",
        payment_method_types: ["card"],
      });

      res.send({ clientSecret: paymentIntent.client_secret });
    });

    /* =======================
        DASHBOARD STATS
    ======================= */

    // Admin Dashboard Stats (Aggregation)
    app.get("/api/admin-stats", async (req, res) => {
      const totalEvents = await eventsCollection.countDocuments();
      const totalUsers = await usersCollection.countDocuments();

      const paymentStats = await joinedEventsCollection
        .aggregate([
          {
            $group: {
              _id: null,
              totalEarnings: { $sum: "$amount" },
              totalJoined: { $sum: 1 },
            },
          },
        ])
        .toArray();

      // Chart Data: Earnings by Date
      const chartData = await joinedEventsCollection
        .aggregate([
          {
            $group: {
              _id: { $substr: ["$joinedDate", 0, 10] },
              amount: { $sum: "$amount" },
            },
          },
          { $sort: { _id: 1 } },
          { $limit: 10 },
          { $project: { name: "$_id", amount: 1, _id: 0 } },
        ])
        .toArray();

      res.send({
        totalEvents,
        totalUsers,
        totalEarnings: paymentStats[0]?.totalEarnings || 0,
        totalJoined: paymentStats[0]?.totalJoined || 0,
        chartData,
      });
    });

    console.log("✅ MongoDB Connected Successfully");
  } finally {
    // Keep connection open
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Social Development Events Server Running 🚀");
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
