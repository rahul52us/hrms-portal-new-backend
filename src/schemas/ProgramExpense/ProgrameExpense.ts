import mongoose, { Document, Schema } from "mongoose";

enum ApprovalStatus {
  Pending = "pending",
  Approved = "approved",
  Rejected = "rejected",
}

interface Approval {
  status: ApprovalStatus;
  createdAt: Date;
  updatedAt?: Date;
  approvedBy: mongoose.Schema.Types.ObjectId | string;
}

interface EventExpenseValues {
  [key: string]: any;
}

interface EventExpenseDocument extends Document {
  eventType: string;
  thumbnail?: string;
  company : mongoose.Schema.Types.ObjectId | string;
  description?: string;
  documents?: string[];
  approvals: Approval[];
  values: EventExpenseValues;
  createdBy: mongoose.Schema.Types.ObjectId | string;
  createdAt: Date;
  updatedAt?: Date;
}

const approvalSchema = new Schema<Approval>({
  status: {
    type: String,
    enum: Object.values(ApprovalStatus),
    required: true,
  },
  approvedBy : {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  createdAt: {
    type: Date,
    default: new Date(),
  },
  updatedAt: {
    type: Date,
  },
});

const eventExpenseSchema = new Schema<EventExpenseDocument>({
  eventType: {
    type: String,
    required: true,
  },
  company : {
    type: mongoose.Schema.Types.ObjectId,
    ref : 'Company'
  },
  thumbnail: String,
  description: String,
  documents : [{
    type : String
  }],
  approvals: [approvalSchema],
  values: {
    type: Schema.Types.Mixed,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  createdAt: {
    type: Date,
    default: new Date(),
  },
  updatedAt: {
    type: Date,
  },
});

const EventExpenseModel = mongoose.model<EventExpenseDocument>(
  "EventExpense",
  eventExpenseSchema
);

export default EventExpenseModel;