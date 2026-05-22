require('dotenv').config();
const mongoose = require('mongoose');
const admin = require('firebase-admin');
const sa = require('c:/ricemilapp2.0/server/service_account_key.json');
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI).then(async () => {
  const MeterData = require('./models/MeterData');
  
  const datesToCompile = ['2026-05-20', '2026-05-21'];
  
  for (const dateStr of datesToCompile) {
    const start = new Date(`${dateStr}T00:00:00+05:30`);
    const end = new Date(`${dateStr}T23:59:59.999+05:30`);
    
    const hourlyStats = await MeterData.aggregate([
      { $match: { deviceId: 'RICE_MILL_001', timestamp: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: { $hour: { date: "$timestamp", timezone: "+05:30" } },
          avgKVA: { $avg: "$KVA" },
          maxKVA: { $max: "$KVA" },
          avgKW: { $avg: "$KW" },
          maxKW: { $max: "$KW" },
          avgPF: { $avg: "$PF" },
          minKWH: { $min: "$KWH" },
          maxKWH: { $max: "$KWH" },
          count: { $sum: 1 }
        }
      },
      { $sort: { "_id": 1 } }
    ]);
    
    console.log(`${dateStr}: Found ${hourlyStats.length} hourly buckets`);
    
    const statsMap = new Map(hourlyStats.map(h => [h._id, h]));
    const fullDay = [];
    
    for (let hour = 0; hour <= 23; hour++) {
      const h = statsMap.get(hour);
      let kwh = 0;
      if (h) {
        kwh = (h.maxKWH || 0) - (h.minKWH || 0);
        if (kwh < 0) kwh = h.maxKWH || 0;
      }
      fullDay.push({
        hour: hour,
        kwh: kwh,
        avgKVA: h ? (h.avgKVA || 0) : 0,
        maxKVA: h ? (h.maxKVA || 0) : 0,
        avgKW: h ? (h.avgKW || 0) : 0,
        maxKW: h ? (h.maxKW || 0) : 0,
        avgPF: h ? (h.avgPF || 0) : 0
      });
    }
    
    const hasData = fullDay.some(h => h.kwh > 0 || h.maxKVA > 0);
    if (hasData) {
      await db.collection('hourlyUsage').doc(`RICE_MILL_001_${dateStr}`).set({
        deviceId: 'RICE_MILL_001',
        date: dateStr,
        data: fullDay,
        compiledAt: new Date()
      });
      console.log(`  ✅ Saved hourlyUsage for ${dateStr} to Firestore`);
    } else {
      console.log(`  ⚠️  No data for ${dateStr}, skipping`);
    }
  }
  
  mongoose.disconnect();
  process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
