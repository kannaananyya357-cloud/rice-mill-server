const express = require('express');
const router = express.Router();
const User = require('../models/User');
const DeviceToken = require('../models/DeviceToken');
const UserSettings = require('../models/UserSettings');
const admin = require('firebase-admin');
const { verifyToken, requireAdmin } = require('../middleware/auth');

// Register or get user profile (called after Firebase login)
router.post('/sync', verifyToken, async (req, res) => {
  try {
    const { name, email, uid } = req.user;
    
    let user = await User.findOne({ email: email.toLowerCase() });
    
    if (!user) {
      // Check if this is the very first user in the system to allow Admin setup
      const count = await User.countDocuments();
      if (count === 0) {
        user = new User({
          uid,
          name: name || email.split('@')[0],
          email: email.toLowerCase(),
          role: 'Admin',
          assignedDevices: ['RICE_MILL_001']
        });
        await user.save();
      } else {
        // Automatically register as a Guest user
        user = new User({
          uid,
          name: name || email.split('@')[0],
          email: email.toLowerCase(),
          role: 'Guest',
          assignedDevices: []
        });
        await user.save();
        console.log(`👤 New Guest user registered: ${email}`);
      }
    } else {
      // Update UID if it was pre-registered by email
      if (user.uid === user.email) {
        user.uid = uid;
        await user.save();
      }
    }

    // If revoked user now has pending invitations from a new owner, clear the revoked flag
    // so they can see and accept the invite instead of being stuck on the revoked screen
    if (user.accessRevoked && user.pendingInvitations && user.pendingInvitations.length > 0) {
      user.accessRevoked = false;
      user.revokedBy = null;
      await user.save();
    }

    // If revoked user has active assigned devices, clear the revoked flag
    if (user.accessRevoked && user.assignedDevices && user.assignedDevices.length > 0) {
      user.accessRevoked = false;
      user.revokedBy = null;
      await user.save();
    }
    
    let userObj = user.toObject();
    if (user.isSharedUser && user.mainUserEmail) {
      const mainUser = await User.findOne({ email: user.mainUserEmail.toLowerCase() });
      if (mainUser) {
        userObj.millName = mainUser.millName;
      }
    }
    res.json({ ...userObj, isRegistered: true });
  } catch (err) {
    console.error('Error syncing user:', err);
    res.status(500).json({ error: err.message });
  }
});

// Authenticated Route: Update self profile (name, phone, millName)
router.put('/profile/update', verifyToken, async (req, res) => {
  try {
    const user = await User.findOne({ uid: req.user.uid });
    if (!user) return res.status(404).json({ message: 'User not found' });

    const { name, phone, millName } = req.body;
    if (name) user.name = name;
    if (phone) user.phone = phone;
    // Only allow updating millName if not a shared user (shared users inherit the owner's millName)
    if (millName !== undefined && !user.isSharedUser) {
      user.millName = millName;
    }

    await user.save();
    
    // Return updated hierarchical profile
    let userObj = user.toObject();
    if (user.isSharedUser && user.mainUserEmail) {
      const mainUser = await User.findOne({ email: user.mainUserEmail.toLowerCase() });
      if (mainUser) {
        userObj.millName = mainUser.millName;
      }
    }
    res.json({ message: 'Profile updated successfully', user: userObj });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper to get hierarchical user data
async function getHierarchicalUser(email) {
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) return null;
  const userObj = user.toObject();
  if (!user.isSharedUser) {
    userObj.subUsers = await User.find({ mainUserEmail: user.email });
  }
  return userObj;
}

// Admin Route: Register a new user
router.post('/register', async (req, res) => {
  try {
    const { name, phone, email, deviceId, millName } = req.body;
    let normalizedEmail = email.toLowerCase();
    
    let user = await User.findOne({ email: normalizedEmail });
    if (user) {
      return res.status(400).json({ message: 'A user with this email already exists in the system.' });
    }

    user = new User({
      uid: normalizedEmail, // Temporary UID until they sign in
      name,
      phone,
      email: normalizedEmail,
      role: 'User',
      millName: millName || '',
      assignedDevices: deviceId ? [deviceId] : []
    });
    await user.save();
    
    const updatedUser = await getHierarchicalUser(normalizedEmail);
    res.status(201).json({ message: 'User registered successfully', user: updatedUser });
  } catch (error) {
    res.status(500).json({ message: 'Error registering user' });
  }
});

// Admin Route: Get hierarchical user data (Owners and their Shared Users)
router.get('/', async (req, res) => {
  try {
    // Self-healing: Ensure any user with a populated mainUserEmail has isSharedUser set to true
    await User.updateMany(
      { mainUserEmail: { $exists: true, $ne: null, $ne: "" }, isSharedUser: { $ne: true } },
      { $set: { isSharedUser: true } }
    );

    // 1. Fetch all users
    const allUsers = await User.find();
    
    // 2. Separate into Owners and Shared Users
    // An owner is anyone who is NOT a shared user and has at least one device (or is an Admin)
    const owners = allUsers.filter(u => !u.isSharedUser && u.role !== 'Guest');
    const sharedUsers = allUsers.filter(u => u.isSharedUser);

    // 3. Nest Shared Users under their respective Owners
    const hierarchicalData = owners.map(owner => {
      const ownerObj = owner.toObject();
      ownerObj.subUsers = sharedUsers.filter(u => u.mainUserEmail === owner.email);
      return ownerObj;
    });

    res.json(hierarchicalData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Route: Get details of a single user (Owner or Shared User)
router.get('/:email', async (req, res) => {
  try {
    const { email } = req.params;
    const user = await getHierarchicalUser(email);
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Route: Add device to user
router.post('/:email/devices', async (req, res) => {
  try {
    const { email } = req.params;
    const deviceId = req.body.deviceId ? req.body.deviceId.trim() : '';
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

    let user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(404).json({ message: 'User not found' });

    let modified = false;
    if (!user.assignedDevices.includes(deviceId)) {
      user.assignedDevices.push(deviceId);
      modified = true;
    }

    // If access was previously revoked, clear it now that a device is assigned
    if (user.accessRevoked) {
      user.accessRevoked = false;
      user.revokedBy = null;
      modified = true;
    }

    if (modified) {
      await user.save();
    }
    const updatedUser = await getHierarchicalUser(email);
    res.json({ message: 'Device added successfully', user: updatedUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Route: Remove device from user
router.delete('/:email/devices/:deviceId', async (req, res) => {
  try {
    const { email, deviceId } = req.params;
    const trimmedDeviceId = deviceId ? deviceId.trim() : '';
    let user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.assignedDevices = user.assignedDevices.filter(id => id.trim() !== trimmedDeviceId);
    await user.save();
    const updatedUser = await getHierarchicalUser(email);
    res.json({ message: 'Device removed successfully', user: updatedUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Route: Admin share access
router.post('/:email/share', async (req, res) => {
  try {
    const { email } = req.params;
    const { sharedEmail } = req.body;
    let owner = await User.findOne({ email: email.toLowerCase() });
    if (!owner) return res.status(404).json({ message: 'Owner user not found' });

    let sharedUser = await User.findOne({ email: sharedEmail.toLowerCase() });
    if (sharedUser) {
      owner.assignedDevices.forEach(d => {
        if (!sharedUser.assignedDevices.includes(d)) sharedUser.assignedDevices.push(d);
      });
      sharedUser.isSharedUser = true;
      sharedUser.mainUserEmail = owner.email;
      // Clear access revoked flag if they are being shared with again
      sharedUser.accessRevoked = false;
      sharedUser.revokedBy = null;
      await sharedUser.save();
    } else {
      sharedUser = new User({
        uid: sharedEmail.toLowerCase(),
        name: 'Shared User',
        email: sharedEmail.toLowerCase(),
        assignedDevices: [...owner.assignedDevices],
        isSharedUser: true,
        mainUserEmail: owner.email
      });
      await sharedUser.save();
    }

    if (!owner.sharedWith.includes(sharedEmail.toLowerCase())) {
      owner.sharedWith.push(sharedEmail.toLowerCase());
      await owner.save();
    }

    // Sync settings from owner to shared user
    try {
      const ownerSettings = await UserSettings.findOne({ userEmail: owner.email.toLowerCase() });
      if (ownerSettings) {
        const updates = {
          cmdLimit: ownerSettings.cmdLimit,
          cmdMaxGauge: ownerSettings.cmdMaxGauge,
          powerLimit: ownerSettings.powerLimit,
          powerMaxGauge: ownerSettings.powerMaxGauge,
          pfLimit: ownerSettings.pfLimit
        };
        await UserSettings.findOneAndUpdate(
          { userEmail: sharedUser.email.toLowerCase() },
          { $set: updates },
          { upsert: true }
        );
      }
    } catch (syncErr) {
      console.error('Failed to sync settings limits on admin share:', syncErr);
    }

    const updatedOwner = await getHierarchicalUser(email);
    res.json({ message: 'Access shared successfully', sharedUser, owner: updatedOwner });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Route: Revoke shared access
router.delete('/:email/share/:sharedEmail', async (req, res) => {
  try {
    const { email, sharedEmail } = req.params;
    let owner = await User.findOne({ email: email.toLowerCase() });
    if (!owner) return res.status(404).json({ message: 'Owner user not found' });

    let sharedUser = await User.findOne({ email: sharedEmail.toLowerCase() });
    if (sharedUser) {
      // Remove owner's devices from shared user
      sharedUser.assignedDevices = sharedUser.assignedDevices.filter(d => !owner.assignedDevices.includes(d));
      
      // If they have no more devices, they might not need to be a shared user anymore
      // or we can just update the status if this was their main source of access
      if (sharedUser.mainUserEmail === owner.email) {
        sharedUser.isSharedUser = false;
        sharedUser.mainUserEmail = null;
      }
      await sharedUser.save();
    }

    // Remove from owner's sharedWith list
    owner.sharedWith = owner.sharedWith.filter(e => e !== sharedEmail.toLowerCase());
    await owner.save();

    const updatedOwner = await getHierarchicalUser(email);
    res.json({ message: 'Access revoked successfully', owner: updatedOwner });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Route: Delete user
router.delete('/:email', async (req, res) => {
  try {
    const { email } = req.params;
    const user = await User.findOneAndDelete({ email: email.toLowerCase() });
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Also clean up references in other users' sharedWith lists
    await User.updateMany(
      { sharedWith: email.toLowerCase() },
      { $pull: { sharedWith: email.toLowerCase() } }
    );

    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Route: Update user profile
router.put('/:email', async (req, res) => {
  try {
    const { email } = req.params;
    const { name, phone, newEmail, millName, role } = req.body;
    
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (name) user.name = name;
    if (phone) user.phone = phone;
    if (millName) user.millName = millName;
    if (role) user.role = role;
    
    // Clear access revoked flag if the admin is updating the profile
    if (user.accessRevoked) {
      user.accessRevoked = false;
      user.revokedBy = null;
    }
    
    if (newEmail && newEmail.toLowerCase() !== user.email) {
      const normalizedNewEmail = newEmail.toLowerCase();
      // Check if new email is already taken
      const existing = await User.findOne({ email: normalizedNewEmail });
      if (existing) return res.status(400).json({ message: 'New email is already in use' });
      
      const oldEmail = user.email;
      user.email = normalizedNewEmail;

      // Update references in sharedWith lists
      await User.updateMany(
        { sharedWith: oldEmail },
        { $set: { "sharedWith.$": normalizedNewEmail } }
      );
    }

    await user.save();
    const updatedUser = await getHierarchicalUser(user.email);
    res.json({ message: 'User updated successfully', user: updatedUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Owner: Revoke shared access from a user
router.delete('/revoke-access/:sharedEmail', verifyToken, async (req, res) => {
  try {
    const owner = await User.findOne({ uid: req.user.uid });
    if (!owner) return res.status(404).json({ error: 'Owner not found' });

    const sharedEmail = req.params.sharedEmail.toLowerCase();

    // Remove from owner's sharedWith list
    owner.sharedWith = owner.sharedWith.filter(e => e !== sharedEmail);
    await owner.save();

    // Update the shared user: remove devices assigned by this owner & mark as revoked
    const sharedUser = await User.findOne({ email: sharedEmail });
    if (sharedUser) {
      // Remove the devices that were shared by this owner
      // We remove all devices if mainUserEmail matches, otherwise just flag it
      if (sharedUser.mainUserEmail === owner.email) {
        sharedUser.assignedDevices = sharedUser.assignedDevices.filter(d => !owner.assignedDevices.includes(d));
        sharedUser.isSharedUser = false;
        sharedUser.mainUserEmail = null;
        sharedUser.role = 'Guest';
      }
      sharedUser.accessRevoked = true;
      sharedUser.revokedBy = owner.email;
      await sharedUser.save();
    }

    res.json({ message: 'Access revoked successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify email before sharing (pre-flight check)
router.post('/verify-email', verifyToken, async (req, res) => {
  try {
    const { emailToShare } = req.body;
    const owner = await User.findOne({ uid: req.user.uid });

    if (!owner) return res.status(404).json({ error: 'Owner not found' });

    // Shared users cannot share access with others
    if (owner.isSharedUser) {
      return res.json({ status: 'no_permission', message: 'Shared users cannot share access with others.' });
    }

    const normalizedEmail = emailToShare.toLowerCase().trim();

    // 1. Cannot share with yourself
    if (normalizedEmail === owner.email) {
      return res.json({ status: 'self', message: 'You cannot share access with yourself.' });
    }

    // 2. Already in your sharedWith list
    const alreadySharedByYou = owner.sharedWith.includes(normalizedEmail);
    if (alreadySharedByYou) {
      return res.json({ status: 'already_shared', message: 'You have already shared access with this email.' });
    }

    // 3. Check if the target user exists in the system at all
    const targetUser = await User.findOne({ email: normalizedEmail });

    if (!targetUser) {
      // Does not exist yet — they will be created as a placeholder. This is safe.
      return res.json({ status: 'new_user', message: 'This user is not registered yet. They will receive the invite when they sign in.', name: null });
    }

    // Block sharing with another owner (someone who has devices and is not a shared user)
    if (targetUser.assignedDevices && targetUser.assignedDevices.length > 0 && !targetUser.isSharedUser) {
      return res.json({ status: 'is_owner', message: 'You cannot share access with another owner.' });
    }

    // 4. Check if the target user is shared by another owner (already has a mainUserEmail that is not this owner)
    const sharedByOtherOwner = targetUser.isSharedUser && targetUser.mainUserEmail && targetUser.mainUserEmail !== owner.email;

    return res.json({
      status: 'ok',
      name: targetUser.name,
      role: targetUser.role,
      sharedByOtherOwner,
      otherOwnerEmail: sharedByOtherOwner ? targetUser.mainUserEmail : null,
      message: sharedByOtherOwner
        ? `This user is already managed by ${targetUser.mainUserEmail}. They can still receive your invite.`
        : `User found: ${targetUser.name}.`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Share device access with another email
router.post('/share', verifyToken, async (req, res) => {
  try {
    const { emailToShare, deviceIds } = req.body;
    const owner = await User.findOne({ uid: req.user.uid });
    
    if (!owner) return res.status(404).json({ error: 'Owner not found' });
    if (owner.isSharedUser) {
      return res.status(403).json({ error: 'Shared users are not allowed to share access with others.' });
    }
    if (!owner.assignedDevices || owner.assignedDevices.length === 0) {
      return res.status(400).json({ error: 'No devices to share' });
    }

    // Use provided deviceIds or default to all if not specified (backward compatibility)
    const devicesToShare = deviceIds && deviceIds.length > 0 
      ? deviceIds 
      : owner.assignedDevices;

    // Validate that the owner actually owns these devices
    const unauthorized = devicesToShare.filter(d => !owner.assignedDevices.includes(d));
    if (unauthorized.length > 0) {
      return res.status(403).json({ error: 'You do not have access to some of these devices' });
    }

    let recipient = await User.findOne({ email: emailToShare.toLowerCase() });
    
    // Block sharing with another owner
    if (recipient && recipient.assignedDevices && recipient.assignedDevices.length > 0 && !recipient.isSharedUser) {
      return res.status(403).json({ error: 'You cannot share access with another owner.' });
    }

    // Create invitation instead of immediate assignment
    const invitation = {
      ownerEmail: owner.email,
      ownerName: owner.name,
      millName: owner.millName,
      devices: devicesToShare
    };

    if (recipient) {
      // Clear revoked flag so they can see the invitation
      recipient.accessRevoked = false;
      recipient.revokedBy = null;
      
      recipient.pendingInvitations.push(invitation);
      await recipient.save();
    } else {
      // Create a placeholder user so they get the invite on first login
      recipient = new User({
        uid: emailToShare.toLowerCase(),
        name: emailToShare.split('@')[0],
        email: emailToShare.toLowerCase(),
        role: 'Guest',
        pendingInvitations: [invitation]
      });
      await recipient.save();
    }

    if (!owner.sharedWith.includes(emailToShare.toLowerCase())) {
      owner.sharedWith.push(emailToShare.toLowerCase());
      await owner.save();
    }

    // Send FCM notification to recipient
    try {
      const tokens = await DeviceToken.find({ userEmail: emailToShare.toLowerCase() });
      if (tokens && tokens.length > 0) {
        const message = {
          notification: {
            title: 'New Device Access Invite',
            body: `${owner.name || owner.email} wants to share device access with you.`,
          },
          data: {
            title: 'New Device Access Invite',
            body: `${owner.name || owner.email} wants to share device access with you.`,
            alertId: 'INVITE',
          },
          tokens: tokens.map(t => t.token),
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
                  title: 'New Device Access Invite',
                  body: `${owner.name || owner.email} wants to share device access with you.`,
                },
                sound: 'default',
                badge: 1,
              },
            },
          },
        };
        await admin.messaging().sendEachForMulticast(message);
      }
    } catch (err) {
      console.error('Error sending invite notification:', err);
    }

    res.json({ message: 'Invitation sent successfully', status: 'pending' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accept Invitation
router.post('/invitations/accept', verifyToken, async (req, res) => {
  try {
    const { ownerEmail } = req.body;
    const user = await User.findOne({ uid: req.user.uid });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const invite = user.pendingInvitations.find(i => i.ownerEmail === ownerEmail);
    if (!invite) return res.status(404).json({ error: 'Invitation not found' });

    // Add devices
    for (const deviceId of invite.devices) {
      if (!user.assignedDevices.includes(deviceId)) {
        user.assignedDevices.push(deviceId);
      }
    }

    // Upgrade Role and set relations
    user.isSharedUser = true;
    user.mainUserEmail = invite.ownerEmail;
    if (user.role === 'Guest') {
      user.role = 'User';
      user.millName = invite.millName;
    }

    // Clear any previously revoked access flag since user has now accepted a new invite
    user.accessRevoked = false;
    user.revokedBy = null;

    // Remove invite
    user.pendingInvitations = user.pendingInvitations.filter(i => i.ownerEmail !== ownerEmail);
    
    await user.save();

    // Sync settings from owner to accepting user
    try {
      if (invite.ownerEmail) {
        const ownerSettings = await UserSettings.findOne({ userEmail: invite.ownerEmail.toLowerCase() });
        if (ownerSettings) {
          const updates = {
            cmdLimit: ownerSettings.cmdLimit,
            cmdMaxGauge: ownerSettings.cmdMaxGauge,
            powerLimit: ownerSettings.powerLimit,
            powerMaxGauge: ownerSettings.powerMaxGauge,
            pfLimit: ownerSettings.pfLimit
          };
          await UserSettings.findOneAndUpdate(
            { userEmail: user.email.toLowerCase() },
            { $set: updates },
            { upsert: true }
          );
        }
      }
    } catch (syncErr) {
      console.error('Failed to sync settings limits on invitation acceptance:', syncErr);
    }

    res.json({ message: 'Invitation accepted', user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Decline Invitation
router.post('/invitations/decline', verifyToken, async (req, res) => {
  try {
    const { ownerEmail } = req.body;
    const user = await User.findOne({ uid: req.user.uid });
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.pendingInvitations = user.pendingInvitations.filter(i => i.ownerEmail !== ownerEmail);
    await user.save();
    res.json({ message: 'Invitation declined' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get shared users details for owner
router.get('/:email/shared-details', verifyToken, async (req, res) => {
  try {
    const { email } = req.params;
    const owner = await User.findOne({ email: email.toLowerCase() });
    if (!owner) return res.status(404).json({ message: 'Owner not found' });

    const sharedUsers = await User.find({ email: { $in: owner.sharedWith } });
    
    const details = sharedUsers.map(u => ({
      email: u.email,
      name: u.name,
      role: u.role,
      status: u.mainUserEmail === owner.email ? 'Accepted' : 'Pending'
    }));

    res.json(details);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});




module.exports = router;
