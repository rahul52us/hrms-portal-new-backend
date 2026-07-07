import mongoose from "mongoose";

const QuizCategorySchema = new mongoose.Schema({
  title: {
    type: String,
    trim: true,
    required: true,
  },
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Company",
    required : true
  },
  thumbnail: {
    name: String,
    url: String,
    type: String,
  },
  description: {
    type: mongoose.Schema.Types.Mixed,
    trim: true,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  popularity: {
    views: {
      type: Number,
      default: 0,
    },
    likes: {
      type: Number,
      default: 0,
    },
  },
  published: {
    type: Boolean,
    default: false,
  },
  averageRating: {
    type: Number,
    min: 0,
    max: 5,
    default: 0,
  },
  tags: [
    {
      type: String,
      trim: true,
    },
  ],
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
  },
});

QuizCategorySchema.index({ title: "text", tags: "text" });

export default mongoose.model("QuizCategory", QuizCategorySchema);
