const mongoose = require('mongoose');

const meterDataSchema = new mongoose.Schema({
  deviceId: { type: String, default: 'RICE_MILL_001', index: true },
  meterId: { type: Number, default: 1 },
  KW: Number,
  KW_R: Number,
  KW_Y: Number,
  KW_B: Number,
  KVAR: Number,
  KVAR_R: Number,
  KVAR_Y: Number,
  KVAR_B: Number,
  KVA: Number,
  KVA_R: Number,
  KVA_Y: Number,
  KVA_B: Number,
  PF: Number,
  PF_R: Number,
  PF_Y: Number,
  PF_B: Number,
  KWH: Number,
  KVAH: Number,
  KVARH_Ind: Number,
  KVARH_Cap: Number,
  V1N: Number,
  V2N: Number,
  V3N: Number,
  V12: Number,
  V23: Number,
  V31: Number,
  I1: Number,
  I2: Number,
  I3: Number,
  Freq: Number,
  IN: Number,
  timestamp: { type: Date, default: Date.now }
});

// TTL Index to delete data older than 48 hours (2 days)
meterDataSchema.index({ timestamp: 1 }, { expireAfterSeconds: 172800 });

// Compound index for query optimization
meterDataSchema.index({ deviceId: 1, timestamp: -1 });

module.exports = mongoose.model('MeterData', meterDataSchema);

