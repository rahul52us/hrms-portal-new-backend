import mongoose, { Document, Schema } from "mongoose";

export interface OfficeLocationI extends Document {
  company: mongoose.Types.ObjectId;
  name: string;
  code: string;
  address?: string;
  city: string;
  state?: string;
  country?: string;
  pinCode?: string;
  is_active: boolean;
  deletedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const OfficeLocationSchema = new Schema<OfficeLocationI>(
  {
    company: {
      type: Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    address: { type: String, trim: true },
    city: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    state: { type: String, trim: true },
    country: { type: String, trim: true },
    pinCode: { type: String, trim: true },
    is_active: {
      type: Boolean,
      default: true,
      index: true,
    },
    deletedAt: {
      type: Date,
      default: null,
      index: true,
    },
  },
  { timestamps: true }
);

OfficeLocationSchema.index(
  { company: 1, code: 1 },
  {
    unique: true,
    partialFilterExpression: { deletedAt: null },
  }
);

const OfficeLocation =
  (mongoose.models.OfficeLocation as mongoose.Model<OfficeLocationI>) ||
  mongoose.model<OfficeLocationI>("OfficeLocation", OfficeLocationSchema);

export default OfficeLocation;
