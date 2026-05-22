const admin = require('firebase-admin');
const User = require('../models/User');

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    if (decodedToken.email) {
      decodedToken.email = decodedToken.email.toLowerCase();
    }
    req.user = decodedToken; // contains uid, email, etc.

    // Fetch full user from DB if needed
    const dbUser = await User.findOne({ uid: decodedToken.uid });
    if (dbUser) {
      req.dbUser = dbUser;
    }

    next();
  } catch (err) {
    console.error('Token verification error:', err.message);
    res.status(403).json({ error: 'Invalid or expired token' });
  }
};

const requireAdmin = async (req, res, next) => {
  if (req.dbUser && req.dbUser.role === 'Admin') {
    next();
  } else {
    res.status(403).json({ error: 'Admin access required' });
  }
};

module.exports = { verifyToken, requireAdmin };
