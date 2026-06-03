require('dotenv').config();
const mongoose = require('mongoose');

async function check() {
  try {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
    console.log('Connecting to:', uri ? 'MongoDB Atlas' : 'No URI found');
    await mongoose.connect(uri);
    
    const RegistrationRequest = require('./models/RegistrationRequest');
    const reqs = await RegistrationRequest.find();
    console.log('Pending Requests count:', reqs.length);
    console.log('Requests details:', JSON.stringify(reqs, null, 2));
    
    const User = require('./models/User');
    const admins = await User.find({ role: 'Admin' });
    console.log('Admin Users:', admins.map(a => ({ email: a.email, role: a.role })));
  } catch (err) {
    console.error('Error:', err);
  } finally {
    process.exit(0);
  }
}

check();
