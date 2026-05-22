require('dotenv').config();
const mongoose = require('mongoose');
mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI).then(async () => {
  const MeterData = require('./models/MeterData');
  const count = await MeterData.countDocuments();
  const oldest = await MeterData.findOne().sort({ timestamp: 1 }).lean();
  const newest = await MeterData.findOne().sort({ timestamp: -1 }).lean();
  console.log('Atlas MeterData count:', count);
  if (oldest) console.log('Oldest:', oldest.timestamp?.toISOString(), 'deviceId:', oldest.deviceId);
  if (newest) console.log('Newest:', newest.timestamp?.toISOString(), 'deviceId:', newest.deviceId);
  
  // Check distinct dates
  const dates = await MeterData.aggregate([
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp', timezone: '+05:30' } } } },
    { $sort: { _id: -1 } },
    { $limit: 5 }
  ]);
  console.log('Distinct dates in MeterData:', dates.map(d => d._id).join(', '));
  mongoose.disconnect();
  process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
