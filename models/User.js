const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  uid: { type: String, required: true, unique: true }, // Firebase UID
  name: { type: String, required: true },
  email: { type: String, required: true },
  phone: { type: String },
  role: { type: String, enum: ['Admin', 'User', 'Guest'], default: 'User' },
  fcmToken: { type: String },
  assignedDevices: [{ type: String }], // Array of MAC addresses/Device IDs
  millName: { type: String, default: '' },
  isSharedUser: { type: Boolean, default: false },
  mainUserEmail: { type: String }, // Who gave them access
  sharedWith: [{ type: String }], // Emails of people they shared with
  accessRevoked: { type: Boolean, default: false }, // Set when owner removes access
  revokedBy: { type: String }, // Email of the owner who revoked access
  pendingInvitations: [{
    ownerEmail: String,
    ownerName: String,
    millName: String,
    devices: [String],
    timestamp: { type: Date, default: Date.now }
  }]
}, { timestamps: true });

userSchema.post('save', async function(doc) {
  try {
    const DeviceAssignment = require('./DeviceAssignment');
    const admin = require('firebase-admin');
    const userEmail = doc.email.toLowerCase();
    
    const activeAssignments = await DeviceAssignment.find({ userEmail, status: 'Active' });
    const activeDeviceIds = activeAssignments.map(a => a.deviceId);
    
    const currentDevices = doc.assignedDevices || [];
    
    // ── Added devices ────────────────────────────────────────────────────────
    const addedDevices = currentDevices.filter(d => !activeDeviceIds.includes(d));
    for (const deviceId of addedDevices) {
      const record = await DeviceAssignment.create({
        deviceId,
        userEmail,
        assignedAt: new Date(),
        status: 'Active',
        assignedBy: doc.mainUserEmail || 'System'
      });

      // Sync to Firestore
      try {
        if (admin.apps.length > 0) {
          await admin.firestore()
            .collection('deviceAssignments')
            .doc(record._id.toString())
            .set({
              mongoId:    record._id.toString(),
              deviceId,
              userEmail,
              assignedBy: doc.mainUserEmail || 'System',
              status:     'Active',
              assignedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }
      } catch (fsErr) {
        console.error('Firestore assignment sync error:', fsErr.message);
      }
    }
    
    // ── Removed devices ──────────────────────────────────────────────────────
    const removedDevices = activeDeviceIds.filter(d => !currentDevices.includes(d));
    for (const deviceId of removedDevices) {
      await DeviceAssignment.updateMany(
        { deviceId, userEmail, status: 'Active' },
        { $set: { status: 'Revoked', revokedAt: new Date() } }
      );

      // Sync revocation to Firestore
      try {
        if (admin.apps.length > 0) {
          const affected = await DeviceAssignment.find({ deviceId, userEmail, status: 'Revoked' }).lean();
          for (const rec of affected) {
            await admin.firestore()
              .collection('deviceAssignments')
              .doc(rec._id.toString())
              .set({ status: 'Revoked', revokedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
          }
        }
      } catch (fsErr) {
        console.error('Firestore revocation sync error:', fsErr.message);
      }
    }
  } catch (err) {
    console.error('Error synchronizing DeviceAssignment in User post-save hook:', err);
  }
});

module.exports = mongoose.model('User', userSchema);

