const mongoose = require('mongoose');

const deviceAssignmentSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, index: true },
  userEmail: { type: String, required: true, index: true },
  assignedAt: { type: Date, default: Date.now },
  assignedBy: { type: String }, // e.g. Owner email or "Admin"
  status: { type: String, enum: ['Active', 'Revoked'], default: 'Active' },
  revokedAt: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model('DeviceAssignment', deviceAssignmentSchema);
