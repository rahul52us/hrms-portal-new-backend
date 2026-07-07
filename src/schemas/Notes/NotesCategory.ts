import mongoose from "mongoose";
interface NotesCategoryInterface extends Document {
  user: mongoose.Schema.Types.ObjectId;
  company: mongoose.Schema.Types.ObjectId;
  thumbnail: string;
  title: string;
  details: string;
  description: string;
  createdBy: mongoose.Schema.Types.ObjectId;
  rating: string;
  discountPrice: string;
  originalPrice: string;
  pricingType: string;
  amountType: string;
  createdAt : Date,
  updatedAt : Date,
  deletedAt : Date,
  parentNotes: mongoose.Schema.Types.ObjectId
}

const NotesCategorySchema = new mongoose.Schema<NotesCategoryInterface>(
  {
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },

    parentNotes : {
      type : mongoose.Schema.Types.ObjectId,
      ref : 'ParentNotes'
    },

    thumbnail: {
      type: String,
      trim: true,
    },

    title: {
      type: String,
      trim: true,
      required: true,
      index: true,
    },

    description: {
      type: String,
      trim: true,
      required: true,
    },

    details: {
      type: String,
      trim: true,
    },

    discountPrice: {
      type: String,
      trim: true,
    },

    originalPrice: {
      type: String,
      trim: true,
    },

    rating: {
      type: String,
      trim: true,
      default:'2'
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    amountType: {
      type: String,
      trim: true,
    },

    pricingType: {
      type: String,
      enum: ["paid", "free"],
      default: "free",
    },

    createdAt:{
      type : Date,
      default : new Date()
    },

    updatedAt: {
      type : Date
    },

    deletedAt : {
       type : Date
    }
  });

export default mongoose.model("NotesCategory", NotesCategorySchema);