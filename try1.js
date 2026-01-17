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

    // Create User (Upsert-like)
    app.post("/api/users", async (req, res) => {
      const user = req.body;
      const existingUser = await usersCollection.findOne({
        email: user.email,
      });

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

    // Get User Role
    app.get("/api/users/role/:email", async (req, res) => {
      const user = await usersCollection.findOne({
        email: req.params.email,
      });

      res.send({
        role: user?.role || "user",
        status: user?.status || "active",
      });
    });

    // All Users (Admin)
    app.get("/api/users", async (req, res) => {
      const users = await usersCollection.find().toArray();
      res.send(users);
    });

    // Update User Status
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

    // Create Event
    app.post("/api/events", async (req, res) => {
      const event = {
        ...req.body,
        participants: 0,
        status: "active",
        postedAt: new Date().toISOString(),
      };

      const result = await eventsCollection.insertOne(event);
      res.send({ success: true, insertedId: result.insertedId });
    });

    // Upcoming Events
    app.get("/api/events/upcoming", async (req, res) => {
      const { category, search } = req.query;
      let query = { eventDate: { $gte: new Date().toISOString() } };

      if (category && category !== "all") {
        query.category = category;
      }
      if (search) {
        query.eventName = { $regex: search, $options: "i" };
      }

      const events = await eventsCollection
        .find(query)
        .sort({ eventDate: 1 })
        .toArray();

      res.send({ success: true, events });
    });

    // Single Event
    app.get("/api/events/:id", async (req, res) => {
      const event = await eventsCollection.findOne({
        _id: new ObjectId(req.params.id),
      });
      res.send({ success: true, event });
    });

    // Organizer Events
    app.get("/api/events/organizer/:email", async (req, res) => {
      const events = await eventsCollection
        .find({ organizerEmail: req.params.email })
        .sort({ postedAt: -1 })
        .toArray();

      res.send({ success: true, events });
    });

    // Update Event (Admin / Organizer)
    app.put("/api/events/:id", async (req, res) => {
      const { organizerEmail, userRole, ...updateFields } = req.body;

      let query = { _id: new ObjectId(req.params.id) };
      if (userRole !== "admin") {
        query.organizerEmail = organizerEmail;
      }

      const result = await eventsCollection.updateOne(query, {
        $set: updateFields,
      });

      if (result.matchedCount === 0) {
        return res.status(403).send({ message: "Unauthorized" });
      }

      res.send({ success: true });
    });

    // Delete Event
    app.delete("/api/events/:id", async (req, res) => {
      const { organizerEmail } = req.query;

      const result = await eventsCollection.deleteOne({
        _id: new ObjectId(req.params.id),
        organizerEmail,
      });

      await joinedEventsCollection.deleteMany({
        eventId: req.params.id,
      });

      res.send({ success: true, deletedCount: result.deletedCount });
    });

    /* =======================
       JOIN EVENTS
    ======================= */

    app.post("/api/join-event", async (req, res) => {
      const { eventId, userEmail, userName, amount, transactionId } = req.body;

      const exists = await joinedEventsCollection.findOne({
        eventId,
        userEmail,
      });

      if (exists) {
        return res.status(409).send({ message: "Already joined" });
      }

      await joinedEventsCollection.insertOne({
        eventId,
        userEmail,
        userName,
        amount: amount || 0,
        transactionId: transactionId || "free",
        joinedDate: new Date().toISOString(),
      });

      await eventsCollection.updateOne(
        { _id: new ObjectId(eventId) },
        { $inc: { participants: 1 } }
      );

      res.send({ success: true });
    });

    app.get("/api/joined-events/:email", async (req, res) => {
      const joins = await joinedEventsCollection
        .find({ userEmail: req.params.email })
        .toArray();

      const ids = joins.map((j) => new ObjectId(j.eventId));

      const events = await eventsCollection
        .find({ _id: { $in: ids } })
        .toArray();

      res.send(events);
    });

    /* =======================
       STRIPE PAYMENT
    ======================= */

    app.post("/api/create-payment-intent", async (req, res) => {
      const { price } = req.body;

      if (!price || isNaN(price) || price < 1) {
        return res.status(400).send({ message: "Invalid amount" });
      }

      const amount = Math.round(price * 100);

      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: "usd",
        payment_method_types: ["card"],
      });

      res.send({ clientSecret: paymentIntent.client_secret });
    });

    /* =======================
       ADMIN DASHBOARD STATS
    ======================= */

    app.get("/api/admin-stats", async (req, res) => {
      const days = parseInt(req.query.days) || 7;
      const dateLimit = new Date();
      dateLimit.setDate(dateLimit.getDate() - days);

      const totalEvents = await eventsCollection.countDocuments();
      const totalUsers = await usersCollection.countDocuments();

      const stats = await joinedEventsCollection
        .aggregate([
          {
            $match: {
              joinedDate: { $gte: dateLimit.toISOString() },
            },
          },
          {
            $group: {
              _id: null,
              totalEarnings: { $sum: "$amount" },
              totalJoined: { $sum: 1 },
            },
          },
        ])
        .toArray();

      const chartData = await joinedEventsCollection
        .aggregate([
          {
            $match: {
              joinedDate: { $gte: dateLimit.toISOString() },
            },
          },
          {
            $group: {
              _id: { $substr: ["$joinedDate", 0, 10] },
              amount: { $sum: "$amount" },
            },
          },
          { $sort: { _id: 1 } },
          { $project: { name: "$_id", amount: 1, _id: 0 } },
        ])
        .toArray();

      res.send({
        totalEvents,
        totalUsers,
        totalEarnings: stats[0]?.totalEarnings || 0,
        totalJoined: stats[0]?.totalJoined || 0,
        chartData,
      });
    });

    // Recent Joins
    app.get("/api/recent-joins", async (req, res) => {
      const joins = await joinedEventsCollection
        .find()
        .sort({ joinedDate: -1 })
        .limit(10)
        .toArray();

      res.send(joins);
    });

    console.log("✅ MongoDB Connected Successfully");
  } catch (error) {
    console.error(error);
  }
}

run();

app.get("/", (req, res) => {
  res.send("Social Development Events Server Running 🚀");
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
