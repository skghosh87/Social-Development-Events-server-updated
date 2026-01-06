const express = require("express");
const cors = require("cors");

require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

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
    // await client.connect();

    const database = client.db("socialdevelopmentevent");
    const eventsCollection = database.collection("events");
    const joinedEventsCollection = database.collection("joinedEvents");
    const usersCollection = database.collection("users");
    // User  Api
    // ১. ইউজার ডাটাবেজে সেভ করা (Upsert logic)
    app.post("/api/users", async (req, res) => {
      const user = req.body;
      const query = { email: user.email };
      const existingUser = await usersCollection.findOne(query);

      if (existingUser) {
        return res.send({ message: "User already exists", insertedId: null });
      }

      // ডিফল্টভাবে সবাই 'user' এবং 'active' থাকবে
      const result = await usersCollection.insertOne({
        ...user,
        role: "user",
        status: "active",
        createdAt: new Date().toISOString(),
      });
      res.send(result);
    });

    // ২. ইউজারের রোল চেক করা (Frontend-এ AdminRoute এর জন্য লাগবে)
    app.get("/api/users/role/:email", async (req, res) => {
      const email = req.params.email;
      const user = await usersCollection.findOne({ email });
      res.send({
        role: user?.role || "user",
        status: user?.status || "active",
      });
    });
    // ৩. সব ইউজারদের লিস্ট পাওয়া (শুধুমাত্র অ্যাডমিনের জন্য)
    app.get("/api/users", async (req, res) => {
      const result = await usersCollection.find().toArray();
      res.send(result);
    });

    // ৪. ইউজারের স্ট্যাটাস আপডেট (Active/Suspend)
    app.patch("/api/users/status/:id", async (req, res) => {
      const id = req.params.id;
      const { status } = req.body; // status: 'suspended' or 'active'
      const filter = { _id: new ObjectId(id) };
      const updateDoc = { $set: { status: status } };
      const result = await usersCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    // ৫. সব ইভেন্ট ট্র্যাক করা (Admin tracking all events)
    app.get("/api/admin/all-events", async (req, res) => {
      const events = await eventsCollection.find().toArray();
      res.send(events);
    });

    // 1st. Event API রুট method: Post (POST/api/events)

    app.post("/api/events", async (req, res) => {
      const newEvent = req.body;

      if (!newEvent.eventName || !newEvent.organizerEmail) {
        return res
          .status(400)
          .send({ success: false, message: "Missing required fields." });
      }

      try {
        const result = await eventsCollection.insertOne(newEvent);
        res.send({
          success: true,
          insertedId: result.insertedId,
          message: "Event created successfully!",
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "Failed to insert event into database.",
        });
      }
    });
    // 2nd. Upcoming Events API রুট (GET/api/events/upcoming)

    app.get("/api/events/upcoming", async (req, res) => {
      const { category, search } = req.query;
      const today = new Date().toISOString();
      let query = { eventDate: { $gte: today } };

      if (category && category !== "all") {
        query.eventType = category;
      }
      if (search) {
        query.eventName = { $regex: new RegExp(search, "i") };
      }
      try {
        const events = await eventsCollection
          .find(query)
          .sort({ eventDate: 1 })
          .toArray();
        res.send({ success: true, events });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "Failed to fetch upcoming events.",
        });
      }
    });
    // 3rd. Single Event Details দেখানোর API রুট (GET /api/events/:id)

    app.get("/api/events/:id", async (req, res) => {
      const id = req.params.id;
      if (!ObjectId.isValid(id)) {
        return res
          .status(400)
          .send({ success: false, message: "Invalid Event ID format." });
      }
      const query = { _id: new ObjectId(id) };
      try {
        const event = await eventsCollection.findOne(query);
        if (!event) {
          return res
            .status(404)
            .send({ success: false, message: "Event not found." });
        }
        res.send({ success: true, event });
      } catch (error) {
        res
          .status(500)
          .send({ success: false, message: "Failed to fetch event details." });
      }
    });
    // 4th. Joined Events দেখানোর API রুট (GET /api/joined-events/:email)

    app.get("/api/joined-events/:email", async (req, res) => {
      const userEmail = req.params.email;
      try {
        const joinedRecords = await joinedEventsCollection
          .find({ userEmail: userEmail })
          .toArray();

        const eventIds = joinedRecords.map(
          (record) => new ObjectId(record.eventId)
        );

        const joinedEvents = await eventsCollection
          .find({ _id: { $in: eventIds } })
          .sort({ eventDate: 1 })
          .toArray();

        res.send(joinedEvents);
      } catch (error) {
        console.error("Error fetching joined events:", error);
        res
          .status(500)
          .send({ success: false, message: "Failed to fetch joined events." });
      }
    });
    // 5th. Event Join করার API রুট (POST /api/join-event)

    app.post("/api/join-event", async (req, res) => {
      const { eventId, userEmail } = req.body;

      if (!eventId || !userEmail) {
        return res
          .status(400)
          .send({ success: false, message: "Missing Event ID or User Email." });
      }

      try {
        const existingJoin = await joinedEventsCollection.findOne({
          eventId: eventId,
          userEmail: userEmail,
        });

        if (existingJoin) {
          return res.status(409).send({
            success: false,
            message: "You have already joined this event.",
          });
        }

        const joinRecord = {
          eventId: eventId,
          userEmail: userEmail,
          joinedDate: new Date().toISOString(),
        };

        const result = await joinedEventsCollection.insertOne(joinRecord);

        await eventsCollection.updateOne(
          { _id: new ObjectId(eventId) },
          { $inc: { participants: 1 } }
        );

        res.send({
          success: true,
          insertedId: result.insertedId,
          message: "Successfully joined the event!",
        });
      } catch (error) {
        console.error("Error joining event:", error);
        res.status(500).send({
          success: false,
          message: "Failed to join event due to server error.",
        });
      }
    });
    // 6th. নিজের তৈরি করা ইভেন্ট লোড করার API রুট (GET /api/events/organizer/:email)

    app.get("/api/events/organizer/:email", async (req, res) => {
      const organizerEmail = req.params.email;
      if (!organizerEmail) {
        return res
          .status(400)
          .send({ success: false, message: "Organizer Email is required." });
      }
      try {
        const query = { organizerEmail: organizerEmail };
        const myEvents = await eventsCollection
          .find(query)
          .sort({ postedAt: -1 })
          .toArray();
        res.send({ success: true, events: myEvents });
      } catch (error) {
        console.error("Error fetching my events:", error);
        res.status(500).send({
          success: false,
          message: "Failed to fetch events created by user.",
        });
      }
    });
    // 7th. ইভেন্ট আপডেট করার API রুট (PUT /api/events/:id)
    // এই রুটটি অ্যাডমিন এবং অর্গানাইজার (মালিক) উভয়ের জন্যই কাজ করবে

    app.put("/api/events/:id", async (req, res) => {
      const id = req.params.id;
      const updatedEventData = req.body;

      // ফ্রন্টেন্ড থেকে পাঠানো ডেটা এবং ইউজারের ইনফো (রোল এবং ইমেইল)
      const { organizerEmail, userRole, ...updateFields } = updatedEventData;

      // ১. ভ্যালিডেশন চেক
      if (!ObjectId.isValid(id)) {
        return res.status(400).send({
          success: false,
          message: "Invalid ID format.",
        });
      }

      try {
        // ২. কুয়েরি তৈরি (Role-Based Authorization)
        let query = { _id: new ObjectId(id) };

        // যদি ইউজার 'admin' না হয়, তবে অবশ্যই তাকে ওই ইভেন্টের মালিক (Organizer) হতে হবে
        if (userRole !== "admin") {
          if (!organizerEmail) {
            return res.status(400).send({
              success: false,
              message: "Organizer email is required for non-admin users.",
            });
          }
          query.organizerEmail = organizerEmail;
        }

        // ৩. আপডেট করার জন্য ডেটা সেট করা
        const updateDoc = {
          $set: {
            eventName: updateFields.eventName,
            category: updateFields.category,
            location: updateFields.location,
            description: updateFields.description,
            image: updateFields.image,
            eventDate: updateFields.eventDate,
            // অ্যাডমিন চাইলে সরাসরি স্ট্যাটাসও আপডেট করতে পারে (ঐচ্ছিক)
            status: updateFields.status || "active",
          },
        };

        // ৪. ডাটাবেজ আপডেট অপারেশন
        const result = await eventsCollection.updateOne(query, updateDoc);

        // ৫. রেজাল্ট হ্যান্ডলিং
        if (result.matchedCount === 0) {
          return res.status(403).send({
            success: false,
            message:
              "Forbidden: You don't have permission to update this event or event not found.",
          });
        }

        res.send({
          success: true,
          message:
            userRole === "admin"
              ? "Event updated by Admin successfully!"
              : "Your event has been updated successfully!",
          modifiedCount: result.modifiedCount,
        });
      } catch (error) {
        console.error("Error updating event:", error);
        res.status(500).send({
          success: false,
          message: "Internal server error while updating event.",
        });
      }
    });
    // 8th. ইভেন্ট ডিলিট করার API রুট (DELETE /api/events/:id)

    app.delete("/api/events/:id", async (req, res) => {
      const id = req.params.id;

      const { organizerEmail } = req.query;

      if (!ObjectId.isValid(id) || !organizerEmail) {
        return res.status(400).send({
          success: false,
          message: "Invalid ID or missing organizer email.",
        });
      }

      try {
        const query = {
          _id: new ObjectId(id),
          organizerEmail: organizerEmail,
        };

        const result = await eventsCollection.deleteOne(query);

        if (result.deletedCount === 0) {
          return res.status(403).send({
            success: false,
            message:
              "Forbidden: You can only delete events you created or event not found.",
          });
        }

        await joinedEventsCollection.deleteMany({ eventId: id });

        res.send({
          success: true,
          message: "Event deleted successfully!",
          deletedCount: result.deletedCount,
        });
      } catch (error) {
        console.error("Error deleting event:", error);
        res
          .status(500)
          .send({ success: false, message: "Failed to delete event." });
      }
    });
    // ড্যাশবোর্ড স্ট্যাটাস এবং চার্ট ডেটার জন্য API
    app.get("/api/admin-stats", async (req, res) => {
      try {
        const totalEvents = await eventsCollection.estimatedDocumentCount();
        const totalJoins =
          await joinedEventsCollection.estimatedDocumentCount();

        // ক্যাটাগরি অনুযায়ী ইভেন্ট সংখ্যা (Pie Chart এর জন্য)
        const categoryStats = await eventsCollection
          .aggregate([
            { $group: { _id: "$eventType", value: { $sum: 1 } } },
            { $project: { name: "$_id", value: 1, _id: 0 } },
          ])
          .toArray();

        res.send({
          totalEvents,
          totalJoins,
          categoryStats,
        });
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch stats" });
      }
    });
    // পেমেন্ট ইনটেন্ট তৈরি করার API
    app.post("/api/create-payment-intent", async (req, res) => {
      const { price } = req.body;
      if (!price) return res.status(400).send({ message: "Price is required" });

      const amount = parseInt(price * 100); // সেন্টে রূপান্তর

      const paymentIntent = await stripe.paymentIntents.create({
        amount: amount,
        currency: "usd",
        payment_method_types: ["card"],
      });

      res.send({
        clientSecret: paymentIntent.client_secret,
      });
    });

    // await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } catch (error) {
    console.error("MongoDB connection error:", error);
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Social Development Events Server is Running!");
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
