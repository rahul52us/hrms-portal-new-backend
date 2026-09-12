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
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    index: true,
  },
  actor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null,
  },
  title: {
    type: String,
    trim: true,
    maxlength: 160,
  },
  message: {
    type: String,
    required: true,
    trim: true,
    maxlength: 1000,
  },
  category: {
    type: String,
    enum: ['request', 'approval', 'attendance', 'announcement', 'system'],
    default: 'system',
  },
  eventType: {
    type: String,
    trim: true,
    maxlength: 120,
  },
  entityType: {
    type: String,
    trim: true,
    maxlength: 80,
  },
  entityId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
  },
  actionUrl: {
    type: String,
    trim: true,
    default: '',
    maxlength: 500,
  },
  dedupeKey: {
    type: String,
    trim: true,
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
}, { timestamps: true });

notificationSchema.index({ isRead: 1, createdAt: -1 });
notificationSchema.index({ company: 1, recipient: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ company: 1, recipient: 1, createdAt: -1 });
notificationSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } }
);

const NotificationModal = mongoose.model('Notification', notificationSchema);

export default NotificationModal;
