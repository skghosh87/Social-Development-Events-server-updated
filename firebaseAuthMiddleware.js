// import admin and initialize the SDK
// const admin = require("firebase-admin");
// const serviceAccount = require("./path/to/serviceAccountKey.json");

// admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const verifyToken = async (req, res, next) => {
  const authorization = req.headers.authorization;
  if (!authorization) {
    return res
      .status(401)
      .send({ error: true, message: "Unauthorized access" });
  }
  const token = authorization.split(" ")[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.decodedEmail = decodedToken.email;
    next();
  } catch (error) {
    return res
      .status(401)
      .send({ error: true, message: "Unauthorized access" });
  }
};

// app.post("/api/events", verifyToken, async (req, res) => { ... });
