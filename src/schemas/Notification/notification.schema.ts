const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const notificationSchema = new Schema({
  username : {
    type : String
  },
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Company"
  },
  message: {
    type: String,
    required: true,
  },
  type: {
    type: String
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'medium',
  },
  isRead: {
    type: Boolean,
    default: false,
    index: true,
  },
  readAt: {
    type: Date,
    default: null,
  },
  metadata: {
    type: Map,
    of: Schema.Types.Mixed,
  },
  actions: [{
    type: {
      type: String
    },
    label: {
      type: String
    },
    url: {
      type: String,
    },
  }],
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

notificationSchema.index({ isRead: 1, createdAt: -1 });

const NotificationModal = mongoose.model('Notification', notificationSchema);

export default NotificationModal;