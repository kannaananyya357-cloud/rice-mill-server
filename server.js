require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const mqtt = require('mqtt');
const cors = require('cors');
const cron = require('node-cron');
const http = require('http');
const { Server } = require('socket.io');

// ── In-Memory Cache with TTL ────────────────────────────────────────────────
class MemCache {
  constructor(ttlMs = 5 * 60 * 1000) { // default 5 min TTL
    this._store = new Map();
    this._ttl = ttlMs;
  }
  get(key) {
    const entry = this._store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.exp) { this._store.delete(key); return undefined; }
    return entry.val;
  }
  set(key, val, ttlMs) {
    this._store.set(key, { val, exp: Date.now() + (ttlMs || this._ttl) });
  }
  del(key) { this._store.delete(key); }
  clear() { this._store.clear(); }
}

const cache = new MemCache(5 * 60 * 1000);       // 5 min for general data
const hourlyCache = new MemCache(10 * 60 * 1000); // 10 min for hourly timelines
const histCache = new MemCache(2 * 60 * 1000);    // 2 min for historical-usage (changes with live today)

const MeterData = require('./models/MeterData');
const DailyUsage = require('./models/DailyUsage');
const UserSettings = require('./models/UserSettings');
const Notification = require('./models/Notification');
const DeviceToken = require('./models/DeviceToken');
const User = require('./models/User');
const DeviceAssignment = require('./models/DeviceAssignment');
const DeviceReset = require('./models/DeviceReset');
const admin = require('firebase-admin');

// Routes
const userRoutes = require('./routes/userRoutes');
const { verifyToken } = require('./middleware/auth');

// Initialize Firebase Admin + Firestore
let db = null;
try {
  const serviceAccount = require('./service_account_key.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  db = admin.firestore();
  console.log('🔥 Firebase Admin + Firestore initialized');
} catch (err) {
  console.error('❌ Firebase Admin initialization error:', err.message);
}

// ── Firestore Sync Helpers ──────────────────────────────────────────────────
async function syncToFirestore(collection, docId, data) {
  if (!db) return;
  try {
    await db.collection(collection).doc(docId).set(data, { merge: true });
  } catch (e) {
    // Non-fatal: log but don't break main flow
    console.error(`⚠️  Firestore sync error [${collection}]:`, e.message);
  }
}

async function addToFirestore(collection, data) {
  if (!db) return null;
  try {
    const ref = await db.collection(collection).add(data);
    return ref.id;
  } catch (e) {
    console.error(`⚠️  Firestore add error [${collection}]:`, e.message);
    return null;
  }
}

async function deleteFromFirestore(collection, docId) {
  if (!db) return;
  try {
    await db.collection(collection).doc(docId).delete();
  } catch (e) {
    console.error(`⚠️  Firestore delete error [${collection}]:`, e.message);
  }
}

function fsToDate(val) {
  if (!val) return null;
  if (typeof val.toDate === 'function') return val.toDate();
  return new Date(val);
}

async function compileAndSaveHourlyTimeline(deviceId, dateStr) {
  if (!db) return null;
  try {
    const start = new Date(`${dateStr}T00:00:00+05:30`);
    const end = new Date(`${dateStr}T23:59:59.999+05:30`);

    const hourlyStats = await MeterData.aggregate([
      { $match: { deviceId, timestamp: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: { $hour: { date: "$timestamp", timezone: "+05:30" } },
          avgKVA: { $avg: "$KVA" },
          maxKVA: { $max: "$KVA" },
          avgKW: { $avg: "$KW" },
          maxKW: { $max: "$KW" },
          avgPF: { $avg: "$PF" },
          minKWH: { $min: "$KWH" },
          maxKWH: { $max: "$KWH" }
        }
      },
      { $sort: { "_id": 1 } }
    ]);

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

    const docData = {
      deviceId,
      date: dateStr,
      data: fullDay,
      compiledAt: new Date()
    };

    await syncToFirestore('hourlyUsage', `${deviceId}_${dateStr}`, docData);
    console.log(`✅ Pre-compiled hourly usage for ${deviceId} on ${dateStr} saved to Firestore.`);
    return fullDay;
  } catch (err) {
    console.error(`Error compiling hourly usage for ${deviceId} on ${dateStr}:`, err.message);
    return null;
  }
}

async function getDailyUsagesWithSelfHealing(deviceId, start, end) {
  const localRecords = await DailyUsage.find({
    deviceId,
    date: { $gte: start, $lte: end }
  }).lean();

  const localMap = new Map(localRecords.map(r => [r.date.toISOString().split('T')[0], r]));

  const expectedDates = [];
  let current = new Date(start);
  while (current <= end) {
    expectedDates.push(current.toISOString().split('T')[0]);
    current.setDate(current.getDate() + 1);
  }

  const missingDates = expectedDates.filter(dStr => !localMap.has(dStr));

  if (missingDates.length > 0 && db) {
    console.log(`🔍 [Self-Healing] Missing ${missingDates.length} DailyUsage records in local DB. Querying Firestore in batch...`);
    try {
      const refs = missingDates.map(dStr => db.collection('dailyUsage').doc(`${deviceId}_${dStr}`));
      const docSnaps = await db.getAll(...refs);
      
      const bulkOps = [];
      for (const docSnap of docSnaps) {
        if (docSnap.exists) {
          const data = docSnap.data();
          const dateStr = docSnap.id.split('_')[1];
          const dailyDoc = {
            totalKWh: data.totalKWh,
            maxKVA: data.maxKVA || 0,
            maxKVATime: fsToDate(data.maxKVATime),
            minKVA: data.minKVA || 0,
            minKVATime: fsToDate(data.minKVATime),
            maxKW: data.maxKW || 0,
            maxKWTime: fsToDate(data.maxKWTime),
            minKW: data.minKW || 0,
            minKWTime: fsToDate(data.minKWTime),
            avgPF: data.avgPF || 0
          };
          const targetDate = new Date(`${dateStr}T00:00:00+05:30`);
          
          bulkOps.push({
            updateOne: {
              filter: { date: targetDate, deviceId },
              update: { $set: dailyDoc },
              upsert: true
            }
          });
          
          localRecords.push({
            ...dailyDoc,
            date: targetDate,
            deviceId
          });
        }
      }
      
      if (bulkOps.length > 0) {
        await DailyUsage.bulkWrite(bulkOps);
        console.log(`✅ [Self-Healing] Batch-restored ${bulkOps.length} DailyUsage records from Firestore.`);
      }
    } catch (err) {
      console.error(`⚠️ [Self-Healing] Error batch-restoring from Firestore:`, err.message);
    }
  }

  return localRecords;
}


async function clearNotificationsFromFirestore(userEmail) {
  if (!db) return;
  try {
    const snapshot = await db.collection('notificationHistory')
      .where('userEmail', '==', userEmail.toLowerCase())
      .get();
    
    if (snapshot.empty) return;
    
    const batch = db.batch();
    snapshot.docs.forEach(doc => {
      batch.delete(doc.ref);
    });
    await batch.commit();
  } catch (e) {
    console.error('⚠️  Firestore clear notifications error:', e.message);
  }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// Log all incoming requests for debugging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] 📥 ${req.method} ${req.url}`);
  next();
});

// Mount Routes
app.use('/api/users', userRoutes);

// Root Health Check
app.get('/', (req, res) => res.json({ status: 'ok', message: 'Rice Mill Server is running' }));

// Socket.io Connection Logic
io.on('connection', (socket) => {
  // console.log('🔌 New client connected via WebSocket:', socket.id);
  
  // Clients can join rooms based on device IDs they are authorized to view
  socket.on('joinDeviceRoom', (deviceId) => {
    socket.join(deviceId);
    // console.log(`Client ${socket.id} joined room: ${deviceId}`);
  });

  socket.on('disconnect', () => {
    // console.log('❌ Client disconnected:', socket.id);
  });
});

// MongoDB Connection with optimized timeouts for Atlas
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/ricemill';
mongoose.connect(process.env.MONGODB_URI || MONGO_URI, {
  maxPoolSize: 10,
  minPoolSize: 2,
  socketTimeoutMS: 20000,
  connectTimeoutMS: 15000,
  serverSelectionTimeoutMS: 10000,
  heartbeatFrequencyMS: 15000,
  retryWrites: true,
  retryReads: true,
})
  .then(async () => {
    console.log('MongoDB connected');
    try {
      // Cleanup bad records that might break today's consumption logic
      const result = await MeterData.deleteMany({ $or: [{ KWH: 0 }, { KWH: null }, { KWH: { $exists: false } }] });
      if (result.deletedCount > 0) {
        console.log(`🧹 Cleaned up ${result.deletedCount} invalid MeterData records`);
      }
      // Set default PF limit to 0.85 for all users who have the old default (0.90) or haven't set one
      await UserSettings.updateMany(
        { $or: [{ pfLimit: 0.90 }, { pfLimit: { $exists: false } }] }, 
        { $set: { pfLimit: 0.85 } }
      );

      // Self-heal: Trim assignedDevices for all users to prevent trailing space issues
      const User = require('./models/User');
      const allUsers = await User.find({});
      for (const u of allUsers) {
        if (u.assignedDevices && u.assignedDevices.length > 0) {
          const trimmedDevices = u.assignedDevices.map(d => d.trim()).filter(d => d.length > 0);
          const isChanged = JSON.stringify(u.assignedDevices) !== JSON.stringify(trimmedDevices);
          if (isChanged) {
            u.assignedDevices = trimmedDevices;
            await u.save();
            console.log(`✅ [Self-Heal] Trimmed assignedDevices for user ${u.email}:`, trimmedDevices);
          }
        }
      }
    } catch (e) {
      console.log('⚠️  Note: Cleanup or migration failed:', e.message);
    }
  })
  .catch(err => console.error('MongoDB connection error:', err));

// MQTT Setup
const MQTT_BROKER = 'mqtt://broker.emqx.io:1883';
const MQTT_TOPICS = ['EMS1/data', 'EMS/+/data'];
const mqttClient = mqtt.connect(MQTT_BROKER);

mqttClient.on('connect', () => {
  console.log('✅ Connected to MQTT Broker:', MQTT_BROKER);
  mqttClient.subscribe(MQTT_TOPICS, (err) => {
    if (err) console.error('❌ MQTT Subscribe error:', err);
    else console.log('📁 Subscribed to topics:', MQTT_TOPICS);
  });
});

// Throttle control for saving data (per device)
const lastSaveTimes = new Map();
const SAVE_INTERVAL = 60 * 1000; // 1 minute

// Consecutive breach counters to prevent transient spikes
// Key structure: `${userEmail}_${deviceId}_${alertType}`
const consecutiveBreachCounts = {};

// Process incoming MQTT messages
mqttClient.on('message', async (topic, message) => {
  // console.log(`📩 Received message on [${topic}]:`, message.toString());
  
  let deviceId = null;
  if (topic === 'EMS1/data') {
    deviceId = 'RICE_MILL_001';
  } else if (topic.startsWith('EMS/') && topic.endsWith('/data')) {
    // Pattern: EMS/DEVICE_ID/data
    deviceId = topic.split('/')[1];
  }

  if (deviceId) {
    try {
      const payload = JSON.parse(message.toString());
      if (payload.status === "no_data") return; 
      
      // Map incoming fields to schema fields
      if (payload.KW1 !== undefined) {
        payload.KW_R = payload.KW1;
        payload.KW_Y = payload.KW2;
        payload.KW_B = payload.KW3;
        payload.KW = (payload.KW1 || 0) + (payload.KW2 || 0) + (payload.KW3 || 0);
      }
      if (payload.KVA1 !== undefined) {
        payload.KVA_R = payload.KVA1;
        payload.KVA_Y = payload.KVA2;
        payload.KVA_B = payload.KVA3;
        payload.KVA = (payload.KVA1 || 0) + (payload.KVA2 || 0) + (payload.KVA3 || 0);
      }
      if (payload.PF1 !== undefined) {
        payload.PF_R = payload.PF1;
        payload.PF_Y = payload.PF2;
        payload.PF_B = payload.PF3;
        payload.PF = ((payload.PF1 || 0) + (payload.PF2 || 0) + (payload.PF3 || 0)) / 3;
      }
      if (payload.F !== undefined) {
        payload.Freq = payload.F;
      }

      payload.deviceId = deviceId;

      const now = Date.now();
      const lastSaveTime = lastSaveTimes.get(deviceId) || 0;

      if (now - lastSaveTime >= SAVE_INTERVAL) {
        const newData = new MeterData(payload);
        await newData.save();
        lastSaveTimes.set(deviceId, now);
        // Clear historical cache so today's live data refreshes
        histCache.clear();

        // ── Fire-and-forget Firestore syncs (don't block MQTT processing) ──
        const fsPayload = {
          deviceId,
          KWH: payload.KWH ?? null, KW: payload.KW ?? null,
          KVA: payload.KVA ?? null, PF: payload.PF ?? null,
          V1: payload.V1 ?? null, V2: payload.V2 ?? null, V3: payload.V3 ?? null,
          I1: payload.I1 ?? null, I2: payload.I2 ?? null, I3: payload.I3 ?? null,
          Freq: payload.Freq ?? null,
        };
        syncToFirestore('meterLatest', deviceId, {
          ...fsPayload,
          timestamp: admin.firestore.Timestamp.fromDate(new Date()),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        addToFirestore('meterHistory', {
          ...fsPayload,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
      }

    // Emit data over WebSockets to specific device room
    io.to(payload.deviceId).emit('meterData', payload);

      // Alert Check (Per User)
      const User = require('./models/User');
      const usersWithAccess = await User.find({ assignedDevices: payload.deviceId });
      
      for (const user of usersWithAccess) {
        let settings = await UserSettings.findOne({ userEmail: user.email });
        if (!settings) {
          settings = new UserSettings({ userEmail: user.email });
          await settings.save();
        }

        const alertsToCheck = [
          {
            type: 'CMD',
            isBreached: payload.KVA && payload.KVA > settings.cmdLimit,
            msg: `CMD Alert: Current kVA (${payload.KVA}) exceeded limit (${settings.cmdLimit})!`
          },
          {
            type: 'POWER',
            isBreached: payload.KW && payload.KW > settings.powerLimit,
            msg: `POWER Alert: Current kW (${payload.KW}) exceeded limit (${settings.powerLimit})!`
          },
          {
            type: 'PF',
            isBreached: payload.PF && payload.PF < settings.pfLimit,
            msg: `PF Alert: Current PF (${payload.PF}) fell below limit (${settings.pfLimit})!`
          }
        ];

        const alerts = [];

        for (const alertCheck of alertsToCheck) {
          const key = `${user.email}_${payload.deviceId}_${alertCheck.type}`;
          
          if (alertCheck.isBreached) {
            consecutiveBreachCounts[key] = (consecutiveBreachCounts[key] || 0) + 1;
            // console.log(`⚠️  [Alert Check] ${key} - consecutive breaches: ${consecutiveBreachCounts[key]}/7`);
            
            // Trigger alert on exactly the 7th consecutive breach and reset counter
            if (consecutiveBreachCounts[key] === 7) {
              alerts.push({ type: alertCheck.type, msg: alertCheck.msg });
              consecutiveBreachCounts[key] = 0;
            }
          } else {
            // Reset counter when value is back in the normal range
            if (consecutiveBreachCounts[key] > 0) {
              // console.log(`✅ [Alert Recovered] ${key} - reset breach counter to 0`);
              consecutiveBreachCounts[key] = 0;
            }
          }
        }

        for (let alert of alerts) {
          // Prevent spamming the same user with the same alert type within 5 minutes
          const recentAlert = await Notification.findOne({
            type: alert.type,
            userEmail: user.email, // We should add userEmail to Notification model too
            timestamp: { $gte: new Date(Date.now() - 5 * 60 * 1000) }
          });
          
          if (!recentAlert) {
            const savedNotif = await new Notification({ 
              deviceId: payload.deviceId,
              title: `Limit Exceeded`, 
              message: alert.msg, 
              type: alert.type,
              userEmail: user.email.toLowerCase() 
            }).save();

            // ── Sync notification to Firestore notificationHistory ───────────
            syncToFirestore('notificationHistory', savedNotif._id.toString(), {
              mongoId:   savedNotif._id.toString(),
              deviceId:  payload.deviceId,
              userEmail: user.email.toLowerCase(),
              title:     'Limit Exceeded',
              message:   alert.msg,
              type:      alert.type,
              read:      false,
              timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            
            // Send FCM push notifications to THIS user specifically
            try {
              const normalizedEmail = user.email.toLowerCase();
              const tokens = await DeviceToken.find({ userEmail: normalizedEmail });
              const registrationTokens = tokens.map(t => t.token);

              if (registrationTokens.length > 0) {
                const message = {
                  notification: {
                    title: `⚠️ Alert: ${payload.deviceId}`,
                    body: alert.msg,
                  },
                  data: {
                    title: `⚠️ Alert: ${payload.deviceId}`,
                    body: alert.msg,
                    alertId: alert.type === 'PF' ? 'PF' : `ALERT_${Date.now()}`,
                    deviceId: payload.deviceId,
                  },
                  tokens: registrationTokens,
                  android: {
                    priority: 'high',
                    notification: {
                      channelId: alert.type === 'PF' ? 'normal_alerts_v1' : 'threshold_alerts_v11_loud',
                      sound: alert.type === 'PF' ? 'default' : 'alarm',
                    }
                  },
                  apns: {
                    payload: {
                      aps: {
                        alert: {
                          title: `⚠️ Alert: ${payload.deviceId}`,
                          body: alert.msg,
                        },
                        sound: alert.type === 'PF' ? 'default' : 'alarm.caf',
                        badge: 1,
                      },
                    },
                  },
                };

                const response = await admin.messaging().sendEachForMulticast(message);
                console.log(`📲 Successfully sent ${response.successCount} push notifications to ${user.email}`);
                
                // Cleanup invalid tokens
                if (response.failureCount > 0) {
                  const failedTokens = [];
                  response.responses.forEach((resp, idx) => {
                    if (!resp.success) failedTokens.push(registrationTokens[idx]);
                  });
                  if (failedTokens.length > 0) {
                    await DeviceToken.deleteMany({ token: { $in: failedTokens } });
                  }
                }
              }
            } catch (fcmErr) {
              console.error(`❌ FCM Send Error for ${user.email}:`, fcmErr.message);
            }
          }
        }
      }

    } catch (err) {
      console.error("❌ Error processing MQTT message:", err.message);
    }
  }
});

// Daily Cron Job (Midnight) to calculate total kWh consumed per device
cron.schedule('0 0 * * *', async () => {
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const deviceIds = await MeterData.distinct('deviceId');
    console.log(`⏰ Running midnight cron for ${deviceIds.length} devices...`);

    for (const deviceId of deviceIds) {
      // 1. Consumption calculation
      const minRec = await MeterData.findOne({ 
        deviceId, 
        timestamp: { $gte: yesterday, $lt: todayStart }, 
        KWH: { $gt: 0 } 
      }).sort({ KWH: 1 });
      
      const maxRec = await MeterData.findOne({ 
        deviceId, 
        timestamp: { $gte: yesterday, $lt: todayStart } 
      }).sort({ KWH: -1 });

      if (minRec && maxRec) {
        let consumedKWh = maxRec.KWH - minRec.KWH;
        if (consumedKWh < 0) consumedKWh = maxRec.KWH; // Handle reset

        // 2. Aggregate Max/Min/Avg
        const stats = await MeterData.aggregate([
          { $match: { deviceId, timestamp: { $gte: yesterday, $lt: todayStart } } },
          { $group: {
            _id: null,
            avgPF: { $avg: "$PF" }
          }}
        ]);

        const getDayExtreme = async (field, sortOrder, excludeZero = false) => {
          let query = { deviceId, timestamp: { $gte: yesterday, $lt: todayStart } };
          if (excludeZero) query[field] = { $gt: 0 };
          return await MeterData.findOne(query).sort({ [field]: sortOrder }).lean();
        };

        const maxKVA = await getDayExtreme('KVA', -1);
        const minKVA = await getDayExtreme('KVA', 1, true);
        const maxKW = await getDayExtreme('KW', -1);
        const minKW = await getDayExtreme('KW', 1, true);

        const dailyDoc = {
          totalKWh: consumedKWh,
          maxKVA: maxKVA ? maxKVA.KVA : 0,
          maxKVATime: maxKVA ? maxKVA.timestamp : null,
          minKVA: minKVA ? minKVA.KVA : 0,
          minKVATime: minKVA ? minKVA.timestamp : null,
          maxKW: maxKW ? maxKW.KW : 0,
          maxKWTime: maxKW ? maxKW.timestamp : null,
          minKW: minKW ? minKW.KW : 0,
          minKWTime: minKW ? minKW.timestamp : null,
          avgPF: (stats.length > 0) ? (stats[0].avgPF || 0) : 0
        };

        await DailyUsage.updateOne(
          { date: yesterday, deviceId },
          dailyDoc,
          { upsert: true }
        );
        console.log(`✅ Daily summary [${deviceId}] for ${yesterday.toDateString()} saved.`);

        // ── Sync daily summary to Firestore dailyUsage ───────────────────────
        const dateStr = yesterday.toISOString().split('T')[0]; // YYYY-MM-DD
        syncToFirestore('dailyUsage', `${deviceId}_${dateStr}`, {
          deviceId,
          date:        dateStr,
          ...dailyDoc,
          syncedAt:    admin.firestore.FieldValue.serverTimestamp()
        });

        // ── Compile and save hourly usage to Firestore hourlyUsage ───────────
        await compileAndSaveHourlyTimeline(deviceId, dateStr);
      }
    }

    // 3. Cleanup: Delete data older than 2 days
    const cleanupDate = new Date();
    cleanupDate.setDate(cleanupDate.getDate() - 2);
    const resultMeter = await MeterData.deleteMany({ timestamp: { $lt: cleanupDate } });
    
    let deletedCondCount = 0;
    try {
      const resultCond = await mongoose.connection.db.collection('condenseddatas').deleteMany({ timestamp: { $lt: cleanupDate } });
      deletedCondCount = resultCond.deletedCount;
    } catch (e) {
      console.log('⚠️ Note: condenseddatas cleanup skipped or collection not found:', e.message);
    }
    console.log(`🧹 Cleanup: Removed ${resultMeter.deletedCount} MeterData and ${deletedCondCount} CondensedData records.`);

  } catch (err) {
    console.error('Error in cron job:', err);
  }
});

// Helper to calculate historical day stats on-the-fly (fallback for missing DailyUsage)
async function calculateHistoricalDayStats(deviceId, date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  // console.log(`🔍 Calculating on-the-fly stats for ${deviceId} on ${start.toDateString()}...`);

  // 1. Basic Aggregation (Avg PF, Max/Min Values)
  const stats = await MeterData.aggregate([
    { $match: { deviceId, timestamp: { $gte: start, $lte: end } } },
    { $group: {
      _id: null,
      avgPF: { $avg: "$PF" },
      maxKVA: { $max: "$KVA" },
      minKVA: { $min: { $cond: [{ $gt: ["$KVA", 0] }, "$KVA", 700000] } },
      maxKW: { $max: "$KW" },
      minKW: { $min: { $cond: [{ $gt: ["$KW", 0] }, "$KW", 700000] } },
    }}
  ]);

  if (stats.length === 0) {
    // console.log(`⚠️ No MeterData found for ${deviceId} on ${start.toDateString()}`);
    return null;
  }

  const s = stats[0];
  if (s.minKVA === 700000) s.minKVA = 0;
  if (s.minKW === 700000) s.minKW = 0;

  // 2. Exact Timestamps for Extremes
  const getExtreme = async (field, sortOrder) => {
    return await MeterData.findOne({ deviceId, timestamp: { $gte: start, $lte: end }, [field]: { $gt: 0 } })
      .sort({ [field]: sortOrder })
      .lean();
  };

  const maxKVARec = await getExtreme('KVA', -1);
  const minKVARec = await getExtreme('KVA', 1);
  const maxKWRec = await getExtreme('KW', -1);
  const minKWRec = await getExtreme('KW', 1);

  // 3. Consumption (KWH Delta)
  const minKwh = await MeterData.findOne({ deviceId, timestamp: { $gte: start, $lte: end }, KWH: { $gt: 0 } })
    .sort({ KWH: 1 })
    .lean();
  const maxKwh = await MeterData.findOne({ deviceId, timestamp: { $gte: start, $lte: end } })
    .sort({ KWH: -1 })
    .lean();
  
  let consumption = 0;
  if (minKwh && maxKwh) {
    consumption = maxKwh.KWH - minKwh.KWH;
    if (consumption < 0) consumption = maxKwh.KWH;
  }

  return {
    totalKWh: consumption,
    maxKVA: s.maxKVA || 0,
    maxKVATime: maxKVARec ? maxKVARec.timestamp : null,
    minKVA: s.minKVA || 0,
    minKVATime: minKVARec ? minKVARec.timestamp : null,
    maxKW: s.maxKW || 0,
    maxKWTime: maxKWRec ? maxKWRec.timestamp : null,
    minKW: s.minKW || 0,
    minKWTime: minKWRec ? minKWRec.timestamp : null,
    avgPF: s.avgPF || 0,
    date: start
  };
}


// Get latest meter status
app.get('/api/status', async (req, res) => {
  try {
    const { deviceId } = req.query;
    const query = deviceId ? { deviceId } : {};
    const latest = await MeterData.findOne(query).sort({ timestamp: -1 });
    if (!latest) return res.status(404).json({ error: 'No data found' });
    res.json(latest);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= APIs =================

// History Data for Graph (Hour/Day breakdown)
app.get('/api/history', async (req, res) => {
  try {
    const { range } = req.query; // 'hour' or 'day'
    const now = new Date();
    const startDate = new Date();
    
    if (range === 'hour') {
      startDate.setHours(now.getHours() - 1);
    } else {
      // Default to day (last 24 hours)
      startDate.setHours(now.getHours() - 24);
    }

    // console.log(`📊 Fetching history for range: ${range}`);
    const { deviceId } = req.query;
    const query = { timestamp: { $gte: startDate } };
    if (deviceId) query.deviceId = deviceId;
    
    const data = await MeterData.find(query).sort({ timestamp: 1 });
    // console.log(`📈 Found ${data.length} history records`);
    // In production, we might want to group this data instead of returning all raw points.
    // However, since readings are every 7s, an hour is ~360 points (fine for chart).
    // A day is ~8640 points (might need downsampling, doing simple skip for now)
    
    let chartData = data;
    if (range !== 'hour' && data.length > 200) {
      const step = Math.floor(data.length / 200);
      chartData = data.filter((_, i) => i % step === 0);
    }

    res.json(chartData.map(d => ({ 
      timestamp: d.timestamp, 
      KWH: d.KWH, 
      KVA: d.KVA, 
      KW: d.KW 
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get User Settings
app.get('/api/settings', verifyToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    let settings = await UserSettings.findOne({ userEmail });
    if (!settings) {
      settings = new UserSettings({ userEmail });
      await settings.save();
    }
    // console.log(`⚙️ Settings fetched for ${userEmail}`);
    res.json(settings);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Update User Settings
app.post('/api/settings', verifyToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const { cmdLimit, cmdMaxGauge, powerLimit, powerMaxGauge, pfLimit } = req.body;
    const updates = {};
    if (cmdLimit !== undefined) updates.cmdLimit = cmdLimit;
    if (cmdMaxGauge !== undefined) updates.cmdMaxGauge = cmdMaxGauge;
    if (powerLimit !== undefined) updates.powerLimit = powerLimit;
    if (powerMaxGauge !== undefined) updates.powerMaxGauge = powerMaxGauge;
    if (pfLimit !== undefined) updates.pfLimit = pfLimit;

    const settings = await UserSettings.findOneAndUpdate(
      { userEmail },
      { $set: updates },
      { returnDocument: 'after', upsert: true }
    );
    // console.log(`✅ Settings updated for ${userEmail}:`, updates);

    // Sync settings to all other users who share access to the current user's assigned devices
    try {
      const User = require('./models/User');
      const currentUser = await User.findOne({ email: userEmail });
      if (currentUser && currentUser.assignedDevices && currentUser.assignedDevices.length > 0) {
        const cleanDevices = currentUser.assignedDevices.map(d => d.trim()).filter(d => d.length > 0);
        if (cleanDevices.length > 0) {
          const sharedUsers = await User.find({
            email: { $ne: userEmail },
            assignedDevices: { $in: cleanDevices }
          });
          if (sharedUsers.length > 0) {
            const sharedEmails = sharedUsers.map(u => u.email.toLowerCase());
            for (const email of sharedEmails) {
              await UserSettings.findOneAndUpdate(
                { userEmail: email },
                { $set: updates },
                { upsert: true }
              );
            }
          }

          // Broadcast settingsUpdated event to all device rooms this user has access to
          for (const deviceId of cleanDevices) {
            io.to(deviceId).emit('settingsUpdated', {
              deviceId,
              updates,
              sender: userEmail
            });
            console.log(`📡 Broadcasted settingsUpdated event for device: ${deviceId}`);
          }
        }
      }
    } catch (syncErr) {
      console.error('Failed to sync settings limits across shared users:', syncErr);
    }

    res.json(settings);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Get Notification History
app.get('/api/notifications', verifyToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const latest = await Notification.find({ userEmail }).sort({ timestamp: -1 }).limit(70);
    res.json(latest);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Clear Notifications
app.delete('/api/notifications', verifyToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    await Notification.deleteMany({ userEmail });
    await clearNotificationsFromFirestore(userEmail);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Delete Single Notification
app.delete('/api/notifications/:id', verifyToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const notifId = req.params.id;
    await Notification.findOneAndDelete({ _id: notifId, userEmail });
    await deleteFromFirestore('notificationHistory', notifId);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Register FCM Token
app.post('/api/fcm-token', verifyToken, async (req, res) => {
  try {
    const { token } = req.body;
    const userEmail = req.user.email.toLowerCase();
    if (!token) return res.status(400).json({ error: 'Token is required' });

    await DeviceToken.findOneAndUpdate(
      { token },
      { userEmail, lastUpdated: Date.now() },
      { upsert: true }
    );
    // console.log(`✅ FCM Token registered/updated for ${userEmail}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop Alert API
app.post('/api/stop-alert', async (req, res) => {
  try {
    const { alertId } = req.body;
    // console.log(`🔕 Alert stopped by user: ${alertId}`);

    // Here you could also:
    // 1. Update alert status in DB
    // 2. Stop a physical siren via MQTT
    // 3. Emit a socket event to other users

    res.json({ success: true, message: 'Alert stopped signal received' });
  } catch (err) {
    console.error('❌ Stop alert error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Test Notification Route
app.post('/api/test-notification', async (req, res) => {
  try {
    const { token, title, message } = req.body;
    if (!token) return res.status(400).json({ error: 'Token is required' });

    const payload = {
      notification: {
        title: title || 'Test Notification',
        body: message || 'This is a test notification from the server',
      },
      data: {
        title: title || 'Test Notification',
        body: message || 'This is a test notification from the server',
        alertId: `TEST_${Date.now()}`,
      },
      token: token,
      android: {
        priority: 'high',
        notification: {
          channelId: 'normal_alerts_v1',
          sound: 'default',
        }
      },
      apns: {
        payload: {
          aps: {
            alert: {
              title: title || 'Test Notification',
              body: message || 'This is a test notification from the server',
            },
            sound: 'default',
            badge: 1,
          },
        },
      },
    };

    const response = await admin.messaging().send(payload);
    console.log('✅ Test notification sent successfully:', response);
    res.json({ success: true, messageId: response });
  } catch (err) {
    console.error('❌ Test notification error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get Daily Usage for total calculation (multi-device support)
app.get('/api/daily-usage', verifyToken, async (req, res) => {
  try {
    const { fromDate, deviceId } = req.query; 
    if (!fromDate || !deviceId) return res.status(400).json({ error: 'fromDate and deviceId are required' });

    const start = new Date(fromDate);
    start.setHours(0,0,0,0);
    
    const userEmail = req.user.email.toLowerCase();

    // Check if there is a reset for this user/device that occurred on or after the queried fromDate
    const latestReset = await DeviceReset.findOne({
      deviceId,
      userEmail,
      resetAt: { $gte: start }
    }).sort({ resetAt: -1 }).lean();

    if (latestReset) {
      // If there is a reset after/on the fromDate, the user has cleared the counter.
      // So the consumed units since fromDate is the current latest reading minus the baseline at the reset.
      const currentNow = await MeterData.findOne({ deviceId }).sort({ timestamp: -1 }).lean();
      if (currentNow && currentNow.KWH) {
        let consumption = currentNow.KWH - latestReset.kwhBaseline;
        if (consumption < 0) consumption = currentNow.KWH;
        return res.json({ totalKWhConsumed: consumption });
      }
      return res.json({ totalKWhConsumed: 0 });
    }

    // 1. Get archived totals from start date (excluding today) with Firestore self-healing
    let usages = [];
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0,0,0,0);

    if (start <= yesterday) {
      usages = await getDailyUsagesWithSelfHealing(deviceId, start, yesterday);
    }
    
    const archivedTotal = usages.reduce((sum, u) => sum + (u.totalKWh || 0), 0);

    // 2. Get live total for today
    const liveToday = await calculateTodayConsumption(deviceId, userEmail);

    res.json({ totalKWhConsumed: archivedTotal + liveToday });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Helper to calculate live today usage
async function calculateTodayConsumption(deviceId, userEmail = null) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  // 1. Get the current latest reading
  const currentNow = await MeterData.findOne({ deviceId }).sort({ timestamp: -1 }).lean();
  if (!currentNow || !currentNow.KWH) {
    // console.log(`📊 No current KWH reading found for ${deviceId}`);
    return 0;
  }

  // 2. If userEmail is provided, check if user reset today
  if (userEmail) {
    const latestReset = await DeviceReset.findOne({ deviceId, userEmail: userEmail.toLowerCase() })
      .sort({ resetAt: -1 })
      .lean();
    if (latestReset && latestReset.resetAt >= todayStart) {
      const todayVal = currentNow.KWH - latestReset.kwhBaseline;
      return todayVal < 0 ? 0 : todayVal;
    }
  }

  // 3. Get the baseline (last reading BEFORE today with a valid KWH > 0)
  let baseline = await MeterData.findOne({ 
    deviceId, 
    timestamp: { $lt: todayStart },
    KWH: { $gt: 0 }
  }).sort({ timestamp: -1 }).lean();

  // 4. Fallback: Earliest record from today with a valid KWH > 0
  if (!baseline) {
    baseline = await MeterData.findOne({ 
      deviceId, 
      timestamp: { $gte: todayStart },
      KWH: { $gt: 0 }
    }).sort({ timestamp: 1 }).lean();
  }

  let todayConsumption = 0;
  if (baseline && baseline.KWH && currentNow && currentNow.KWH) {
    if (currentNow.KWH >= baseline.KWH) {
      todayConsumption = currentNow.KWH - baseline.KWH;
    } else {
      // Rollover: Meter reset or wrapped around
      todayConsumption = currentNow.KWH;
    }
    // console.log(`📊 Today Consumption for ${deviceId}: ${todayConsumption.toFixed(2)} kWh (Baseline: ${baseline.KWH}, Current: ${currentNow.KWH})`);
  } else {
    // console.log(`📊 Baseline not found or invalid for ${deviceId}. Baseline: ${JSON.stringify(baseline)}`);
    // If no baseline at all, today's consumption is 0 until we get a second reading
    todayConsumption = 0;
  }
  
  return todayConsumption;
}

// Helper to calculate live today kvah usage
async function calculateTodayKvahConsumption(deviceId, userEmail = null) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  // 1. Get the current latest reading
  const currentNow = await MeterData.findOne({ deviceId }).sort({ timestamp: -1 }).lean();
  if (!currentNow || !currentNow.KVAH) {
    return 0;
  }

  // 2. If userEmail is provided, check if user reset today
  if (userEmail) {
    const latestReset = await DeviceReset.findOne({ deviceId, userEmail: userEmail.toLowerCase() })
      .sort({ resetAt: -1 })
      .lean();
    if (latestReset && latestReset.resetAt >= todayStart) {
      const resetMeterData = await MeterData.findOne({
        deviceId,
        timestamp: { $lte: latestReset.resetAt }
      }).sort({ timestamp: -1 }).lean();
      if (resetMeterData && resetMeterData.KVAH) {
        const todayVal = currentNow.KVAH - resetMeterData.KVAH;
        return todayVal < 0 ? 0 : todayVal;
      }
    }
  }

  // 3. Get the baseline (last reading BEFORE today with a valid KVAH > 0)
  let baseline = await MeterData.findOne({ 
    deviceId, 
    timestamp: { $lt: todayStart },
    KVAH: { $gt: 0 }
  }).sort({ timestamp: -1 }).lean();

  // 4. Fallback: Earliest record from today with a valid KVAH > 0
  if (!baseline) {
    baseline = await MeterData.findOne({ 
      deviceId, 
      timestamp: { $gte: todayStart },
      KVAH: { $gt: 0 }
    }).sort({ timestamp: 1 }).lean();
  }

  let todayConsumption = 0;
  if (baseline && baseline.KVAH && currentNow && currentNow.KVAH) {
    if (currentNow.KVAH >= baseline.KVAH) {
      todayConsumption = currentNow.KVAH - baseline.KVAH;
    } else {
      // Rollover: Meter reset or wrapped around
      todayConsumption = currentNow.KVAH;
    }
  } else {
    todayConsumption = 0;
  }
  
  return todayConsumption;
}

// Get Today's Consumption (Midnight to Now)
app.get('/api/today-usage', verifyToken, async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

    const userEmail = req.user.email.toLowerCase();
    const todayKWh = await calculateTodayConsumption(deviceId, userEmail);
    const todayKVAh = await calculateTodayKvahConsumption(deviceId, userEmail);
    res.json({ todayKWh, todayKVAh });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset Device Counter (user-specific KWH baseline)
app.post('/api/device/reset', verifyToken, async (req, res) => {
  try {
    const { deviceId } = req.body;
    const userEmail = req.user.email.toLowerCase();
    
    if (!deviceId) {
      return res.status(400).json({ error: 'deviceId is required' });
    }

    // Find the latest MeterData reading for this device to establish baseline
    const currentNow = await MeterData.findOne({ deviceId }).sort({ timestamp: -1 }).lean();
    const baseline = currentNow ? (currentNow.KWH || 0) : 0;

    // Calculate consumed units before this reset
    const prevReset = await DeviceReset.findOne({ deviceId, userEmail }).sort({ resetAt: -1 }).lean();
    let prevBaseline = 0;
    if (prevReset) {
      prevBaseline = prevReset.kwhBaseline;
    } else {
      // Find the earliest MeterData
      const firstReading = await MeterData.findOne({ deviceId, KWH: { $gt: 0 } }).sort({ timestamp: 1 }).lean();
      if (firstReading) {
        prevBaseline = firstReading.KWH;
      }
    }
    
    let unitsBeforeReset = baseline - prevBaseline;
    if (unitsBeforeReset < 0) {
      unitsBeforeReset = baseline; // Roll over or meter replaced
    }

    const resetRecord = await DeviceReset.create({
      deviceId,
      userEmail,
      resetAt: new Date(),
      kwhBaseline: baseline,
      unitsBeforeReset: unitsBeforeReset
    });

    // ── Sync reset record to Firestore deviceResets ──────────────────────────
    syncToFirestore('deviceResets', resetRecord._id.toString(), {
      mongoId:          resetRecord._id.toString(),
      deviceId,
      userEmail,
      kwhBaseline:      baseline,
      unitsBeforeReset: unitsBeforeReset,
      resetAt:          admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`🧹 Device reset logged for user ${userEmail} on device ${deviceId} (Baseline: ${baseline} kWh, Consumed: ${unitsBeforeReset} kWh)`);
    res.json({ success: true, baseline, resetAt: resetRecord.resetAt, unitsBeforeReset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Device Resets History
app.get('/api/device/resets', verifyToken, async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

    const userEmail = req.user.email.toLowerCase();
    const resets = await DeviceReset.find({ deviceId, userEmail }).sort({ resetAt: -1 }).lean();
    res.json(resets);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Device Assignment Date
app.get('/api/device/assignment', verifyToken, async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

    const userEmail = req.user.email.toLowerCase();

    // Find the active assignment for this user and device
    const assignment = await DeviceAssignment.findOne({
      deviceId,
      userEmail,
      status: 'Active'
    }).sort({ assignedAt: 1 }).lean();

    if (assignment) {
      return res.json({ assignedAt: assignment.assignedAt });
    }
    return res.json({ assignedAt: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Get Detailed Day History grouped by hour (Digital Wellbeing style)
app.get('/api/analysis/day-history', verifyToken, async (req, res) => {
  try {
    const { deviceId, date } = req.query; // date in format YYYY-MM-DD
    if (!deviceId || !date) {
      return res.status(400).json({ error: 'deviceId and date are required' });
    }

    const now = new Date();
    const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const isToday = todayStr === date;

    // Check in-memory cache first (for historical dates)
    if (!isToday) {
      const cacheKey = `hourly_${deviceId}_${date}`;
      const cached = hourlyCache.get(cacheKey);
      if (cached) return res.json(cached);
    }

    if (!isToday && db) {
      // Try to read pre-compiled data from Firestore
      try {
        const docRef = db.collection('hourlyUsage').doc(`${deviceId}_${date}`);
        const docSnap = await docRef.get();
        if (docSnap.exists) {
          const docData = docSnap.data();
          if (docData && docData.data) {
            hourlyCache.set(`hourly_${deviceId}_${date}`, docData.data);
            return res.json(docData.data);
          }
        }
      } catch (fsErr) {
        console.error('⚠️ Firestore hourlyUsage read error:', fsErr.message);
      }
    }

    const start = new Date(`${date}T00:00:00+05:30`);
    const end = new Date(`${date}T23:59:59.999+05:30`);

    const hourlyStats = await MeterData.aggregate([
      { $match: { deviceId, timestamp: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: { $hour: { date: "$timestamp", timezone: "+05:30" } },
          avgKVA: { $avg: "$KVA" },
          maxKVA: { $max: "$KVA" },
          avgKW: { $avg: "$KW" },
          maxKW: { $max: "$KW" },
          avgPF: { $avg: "$PF" },
          minKWH: { $min: "$KWH" },
          maxKWH: { $max: "$KWH" }
        }
      },
      { $sort: { "_id": 1 } }
    ]);

    const statsMap = new Map(hourlyStats.map(h => [h._id, h]));
    const fullDay = [];

    const currentHour = parseInt(now.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit' }));
    const maxHourLimit = isToday ? currentHour : 23;

    for (let hour = 0; hour <= maxHourLimit; hour++) {
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

    // Cache the calculated historical fullDay to Firestore (fire-and-forget)
    if (!isToday && fullDay.length > 0 && db) {
      const hasData = fullDay.some(h => h.kwh > 0 || h.maxKVA > 0);
      if (hasData) {
        hourlyCache.set(`hourly_${deviceId}_${date}`, fullDay);
        syncToFirestore('hourlyUsage', `${deviceId}_${date}`, {
          deviceId,
          date,
          data: fullDay,
          compiledAt: new Date()
        }); // fire-and-forget, no await
      }
    }

    res.json(fullDay);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= Analysis APIs =================

// 1. Get Historical KWH Usage (up to 50 days)
app.get('/api/analysis/historical-usage', async (req, res) => {
  try {
    const { deviceId, days: daysCount = 7 } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

    const limit = Math.min(parseInt(daysCount), 60);
    const cacheKey = `hist_${deviceId}_${limit}`;
    const cached = histCache.get(cacheKey);
    if (cached) return res.json(cached);

    const results = [];
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    
    // Batch-load all DailyUsage records with self-healing
    const rangeStart = new Date();
    rangeStart.setDate(rangeStart.getDate() - (limit - 1));
    rangeStart.setHours(0, 0, 0, 0);

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    let usages = [];
    if (rangeStart <= yesterday) {
      usages = await getDailyUsagesWithSelfHealing(deviceId, rangeStart, yesterday);
    }
    const recordMap = new Map(usages.map(r => [r.date.toISOString().split('T')[0], r]));

    for (let i = limit - 1; i >= 0; i--) {
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() - i);
      targetDate.setHours(0, 0, 0, 0);
      const dateStr = targetDate.toISOString().split('T')[0];

      let kwh = 0;
      if (i === 0) {
        kwh = await calculateTodayConsumption(deviceId);
      } else {
        const record = recordMap.get(dateStr);
        if (record) {
          kwh = record.totalKWh;
        } else {
          // Fallback: If summary is missing but data is recent (within 2 days), calculate it
          const fallback = await calculateHistoricalDayStats(deviceId, targetDate);
          if (fallback) {
            kwh = fallback.totalKWh;
            await DailyUsage.updateOne({ date: targetDate, deviceId }, fallback, { upsert: true });
            if (db) {
              const dateStr = targetDate.toISOString().split('T')[0];
              syncToFirestore('dailyUsage', `${deviceId}_${dateStr}`, {
                deviceId,
                date: dateStr,
                ...fallback,
                syncedAt: admin.firestore.FieldValue.serverTimestamp()
              });
            }
          } else {
            kwh = 0;
          }
        }
      }

      // Only include day if data was recorded (kwh > 0) OR if it's Today (i === 0)
      if (kwh > 0 || i === 0) {
        results.push({
          label: dayNames[targetDate.getDay()],
          fullDate: targetDate,
          kwh: kwh
        });
      }
    }

    histCache.set(cacheKey, results);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Get Period Max/Min Stats (KVA, KW, PF)
app.get('/api/analysis/period-stats', async (req, res) => {
  try {
    const { deviceId, fromDate, toDate } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });
    
    const start = fromDate ? new Date(fromDate) : new Date();
    if (!fromDate) start.setHours(0, 0, 0, 0);
    const end = toDate ? new Date(toDate) : new Date();

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // 1. Get History from DailyUsage (up to yesterday/end date) with Firestore self-healing
    const historyEnd = end < todayStart ? end : new Date(todayStart - 1);
    historyEnd.setHours(0, 0, 0, 0);
    let historicalUsages = [];
    if (start < todayStart) {
      const normStart = new Date(start);
      normStart.setHours(0, 0, 0, 0);
      historicalUsages = await getDailyUsagesWithSelfHealing(deviceId, normStart, historyEnd);
    }

    // 1.1 Fallback logic: If any historical day summaries are missing, calculate them live
    if (start < todayStart) {
      const normStart = new Date(start);
      normStart.setHours(0, 0, 0, 0);
      const normHistoryEnd = new Date(historyEnd);
      normHistoryEnd.setHours(0, 0, 0, 0);
      const dayDiff = Math.round((normHistoryEnd - normStart) / (1000 * 60 * 60 * 24)) + 1;

      if (dayDiff > 0 && dayDiff <= 3) {
        const historicalMap = new Map(historicalUsages.map(u => [new Date(u.date).setHours(0, 0, 0, 0), u]));
        for (let i = 0; i < dayDiff; i++) {
          const d = new Date(normStart);
          d.setDate(d.getDate() + i);
          const dMidnight = d.getTime();
          if (!historicalMap.has(dMidnight)) {
            const stats = await calculateHistoricalDayStats(deviceId, d);
            if (stats) {
              historicalUsages.push(stats);
              await DailyUsage.updateOne({ date: d, deviceId }, stats, { upsert: true });
              if (db) {
                const dateStr = d.toISOString().split('T')[0];
                syncToFirestore('dailyUsage', `${deviceId}_${dateStr}`, {
                  deviceId,
                  date: dateStr,
                  ...stats,
                  syncedAt: admin.firestore.FieldValue.serverTimestamp()
                });
              }
            }
          }
        }
      }
    }

    // 2. Get Live Today from MeterData
    let todayStats = null;
    if (end >= todayStart) {
      const stats = await MeterData.aggregate([
        { $match: { deviceId, timestamp: { $gte: todayStart, $lte: end } } },
        { $group: {
          _id: null,
          avgPF: { $avg: "$PF" },
          maxKVA: { $max: "$KVA" },
          minKVA: { $min: { $cond: [{ $gt: ["$KVA", 0] }, "$KVA", 700000] } }, // Use large fallback for min
          maxKW: { $max: "$KW" },
          minKW: { $min: { $cond: [{ $gt: ["$KW", 0] }, "$KW", 700000] } },
        }}
      ]);
      if (stats.length > 0) {
        todayStats = stats[0];
        // Correct min values if no data > 0 was found
        if (todayStats.minKVA === 700000) todayStats.minKVA = 0;
        if (todayStats.minKW === 700000) todayStats.minKW = 0;
        
        // For today's extreme times, we need a separate query since aggregate doesn't return which record had the max
        const getLiveExtreme = async (field, sortOrder) => {
          return await MeterData.findOne({ deviceId, timestamp: { $gte: todayStart, $lte: end }, [field]: { $gt: 0 } }).sort({ [field]: sortOrder }).lean();
        };
        todayStats.maxKVARec = await getLiveExtreme('KVA', -1);
        todayStats.minKVARec = await getLiveExtreme('KVA', 1);
        todayStats.maxKWRec = await getLiveExtreme('KW', -1);
        todayStats.minKWRec = await getLiveExtreme('KW', 1);
      }
    }

    // Combine Historical and Today
    const findGlobalMax = (hField, hTimeField, tVal, tTime) => {
      let maxVal = tVal || 0;
      let maxTime = tTime || null;
      for (const u of historicalUsages) {
        if ((u[hField] || 0) >= maxVal) {
          maxVal = u[hField];
          maxTime = u[hTimeField];
        }
      }
      return { val: maxVal, time: maxTime };
    };

    const findGlobalMin = (hField, hTimeField, tVal, tTime) => {
      let minVal = (tVal && tVal > 0) ? tVal : null;
      let minTime = tTime || null;
      for (const u of historicalUsages) {
        if (u[hField] > 0 && (minVal === null || u[hField] <= minVal)) {
          minVal = u[hField];
          minTime = u[hTimeField];
        }
      }
      return { val: minVal || 0, time: minTime };
    };

    const kvaMax = findGlobalMax('maxKVA', 'maxKVATime', todayStats?.maxKVA, todayStats?.maxKVARec?.timestamp);
    const kvaMin = findGlobalMin('minKVA', 'minKVATime', todayStats?.minKVA, todayStats?.minKVARec?.timestamp);
    const kwMax = findGlobalMax('maxKW', 'maxKWTime', todayStats?.maxKW, todayStats?.maxKWRec?.timestamp);
    const kwMin = findGlobalMin('minKW', 'minKWTime', todayStats?.minKW, todayStats?.minKWRec?.timestamp);

    // PF Avg
    let totalPF = historicalUsages.reduce((sum, u) => sum + (u.avgPF || 0), 0);
    let countPF = historicalUsages.length;
    if (todayStats) {
      totalPF += (todayStats.avgPF || 0);
      countPF += 1;
    }
    const globalAvgPF = countPF > 0 ? totalPF / countPF : 0;

    res.json({
      kva: { max: kvaMax.val, maxTime: kvaMax.time, min: kvaMin.val, minTime: kvaMin.time },
      kw: { max: kwMax.val, maxTime: kwMax.time, min: kwMin.val, minTime: kwMin.time },
      avgPF: globalAvgPF
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Get Mixed Stats for multiple devices
app.get('/api/analysis/mixed-stats', async (req, res) => {
  try {
    let { deviceIds, fromDate } = req.query;
    if (!deviceIds) return res.status(400).json({ error: 'deviceIds are required' });
    if (!Array.isArray(deviceIds)) deviceIds = [deviceIds];

    const start = fromDate ? new Date(fromDate) : new Date();
    if (!fromDate) start.setHours(0, 0, 0, 0);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    let totalConsumed = 0;
    let globalMaxKVA = 0;
    let globalMaxKVATime = null;
    let globalAvgPF = 0;
    let pfCount = 0;

    for (const dId of deviceIds) {
      // Archived
      const summaries = await DailyUsage.find({ deviceId: dId, date: { $gte: start, $lt: todayStart } }).lean();
      for (const s of summaries) {
        totalConsumed += (s.totalKWh || 0);
        if ((s.maxKVA || 0) > globalMaxKVA) {
          globalMaxKVA = s.maxKVA;
          globalMaxKVATime = s.maxKVATime;
        }
        globalAvgPF += (s.avgPF || 0);
        pfCount++;
      }
      
      // Live Today
      totalConsumed += await calculateTodayConsumption(dId);
      const liveData = await MeterData.aggregate([
        { $match: { deviceId: dId, timestamp: { $gte: todayStart } } },
        { $group: { _id: null, maxKVA: { $max: "$KVA" }, avgPF: { $avg: "$PF" } } }
      ]);
      if (liveData.length > 0) {
        if (liveData[0].maxKVA > globalMaxKVA) {
          globalMaxKVA = liveData[0].maxKVA;
          // We could fetch the exact time but skipping for mixed stats to keep it fast
          globalMaxKVATime = new Date(); 
        }
        globalAvgPF += (liveData[0].avgPF || 0);
        pfCount++;
      }
    }

    res.json({
      totalConsumedKWh: totalConsumed,
      avgPF: pfCount > 0 ? globalAvgPF / pfCount : 0,
      kva: { max: globalMaxKVA, maxTime: globalMaxKVATime },
      // Mixed stats usually only show top level summaries
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Get Consumption for a specific date range
app.get('/api/analysis/range-usage', async (req, res) => {
  try {
    const { deviceId, fromDate, toDate } = req.query;
    if (!deviceId || !fromDate || !toDate) {
      return res.status(400).json({ error: 'deviceId, fromDate, and toDate are required' });
    }

    const start = new Date(fromDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(toDate);
    end.setHours(0, 0, 0, 0);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // 1. Get archived totals for the range (excluding today) with Firestore self-healing
    const historyEnd = end < todayStart ? end : new Date(todayStart - 1);
    historyEnd.setHours(0, 0, 0, 0);
    let usages = [];
    if (start < todayStart) {
      const normStart = new Date(start);
      normStart.setHours(0, 0, 0, 0);
      usages = await getDailyUsagesWithSelfHealing(deviceId, normStart, historyEnd);

      // 1.1 Fallback: If any summaries are missing in the range, calculate live
      const normHistoryEnd = new Date(historyEnd);
      normHistoryEnd.setHours(0, 0, 0, 0);
      const dayDiff = Math.round((normHistoryEnd - normStart) / (1000 * 60 * 60 * 24)) + 1;

      if (dayDiff > 0 && dayDiff <= 3) {
        const usagesMap = new Map(usages.map(u => [new Date(u.date).setHours(0, 0, 0, 0), u]));
        for (let i = 0; i < dayDiff; i++) {
          const d = new Date(normStart);
          d.setDate(d.getDate() + i);
          const dMidnight = d.getTime();
          if (!usagesMap.has(dMidnight)) {
            const stats = await calculateHistoricalDayStats(deviceId, d);
            if (stats) {
              usages.push(stats);
              await DailyUsage.updateOne({ date: d, deviceId }, stats, { upsert: true });
              if (db) {
                const dateStr = d.toISOString().split('T')[0];
                syncToFirestore('dailyUsage', `${deviceId}_${dateStr}`, {
                  deviceId,
                  date: dateStr,
                  ...stats,
                  syncedAt: admin.firestore.FieldValue.serverTimestamp()
                });
              }
            }
          }
        }
      }
    }

    let totalConsumed = usages.reduce((sum, u) => sum + (u.totalKWh || 0), 0);

    // 2. If end date includes today, add live today consumption
    if (end >= todayStart) {
      totalConsumed += await calculateTodayConsumption(deviceId);
    }

    res.json({ totalKWhConsumed: totalConsumed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Get Monthly Consumption
app.get('/api/analysis/monthly-usage', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

    // Sync all historical records from Firestore if local collection is empty (cold start / cache drop)
    if (db) {
      try {
        const localCount = await DailyUsage.countDocuments({ deviceId });
        if (localCount === 0) {
          console.log(`🔍 [Self-Healing] Local DailyUsage is empty for ${deviceId}. Restoring from Firestore...`);
          const snapshot = await db.collection('dailyUsage')
            .where('deviceId', '==', deviceId)
            .get();
          if (!snapshot.empty) {
            const bulkOps = snapshot.docs.map(doc => {
              const data = doc.data();
              const dateStr = data.date;
              const dailyDoc = {
                totalKWh: data.totalKWh,
                maxKVA: data.maxKVA || 0,
                maxKVATime: fsToDate(data.maxKVATime),
                minKVA: data.minKVA || 0,
                minKVATime: fsToDate(data.minKVATime),
                maxKW: data.maxKW || 0,
                maxKWTime: fsToDate(data.maxKWTime),
                minKW: data.minKW || 0,
                minKWTime: fsToDate(data.minKWTime),
                avgPF: data.avgPF || 0
              };
              const targetDate = new Date(`${dateStr}T00:00:00+05:30`);
              return {
                updateOne: {
                  filter: { date: targetDate, deviceId },
                  update: { $set: dailyDoc },
                  upsert: true
                }
              };
            });
            await DailyUsage.bulkWrite(bulkOps);
            console.log(`✅ [Self-Healing] Bulk-restored ${bulkOps.length} DailyUsage records from Firestore inside monthly-usage.`);
          }
        }
      } catch (err) {
        console.error('⚠️ [Self-Healing] Error self-healing monthly-usage:', err.message);
      }
    }

    const monthlyData = await DailyUsage.aggregate([
      { $match: { deviceId } },
      { $group: {
        _id: {
          year: { $year: "$date" },
          month: { $month: "$date" }
        },
        totalKWh: { $sum: "$totalKWh" }
      }},
      { $sort: { "_id.year": -1, "_id.month": -1 } }
    ]);

    // Format for easier consumption
    const formattedData = monthlyData.map(d => ({
      year: d._id.year,
      month: d._id.month,
      totalKWh: d.totalKWh
    }));

    // Add current month's live data
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    let currentMonthEntry = formattedData.find(d => d.year === currentYear && d.month === currentMonth);
    const liveToday = await calculateTodayConsumption(deviceId);

    if (currentMonthEntry) {
      currentMonthEntry.totalKWh += liveToday;
    } else {
      formattedData.unshift({
        year: currentYear,
        month: currentMonth,
        totalKWh: liveToday
      });
    }

    res.json(formattedData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/profile', verifyToken, async (req, res) => {
  try {
    const User = require('./models/User');
    const user = await User.findOne({ email: req.user.email.toLowerCase() });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
  console.log(`🚀 Rice Mill Server v2.1 (EMS1) listening on port ${PORT}`);
});
