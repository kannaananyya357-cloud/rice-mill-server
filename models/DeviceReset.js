const mongoose = require('mongoose');

const deviceResetSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, index: true },
  userEmail: { type: String, required: true, index: true },
  resetAt: { type: Date, default: Date.now },
  kwhBaseline: { type: Number, required: true },
  unitsBeforeReset: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model('DeviceReset', deviceResetSchema);
