import mongoose from "mongoose";

const QuizQuestionSchema = new mongoose.Schema({
  quiz: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Quiz"
  },
  question: {
    type: String,
    trim: true,
    required: true,
  },
  questionType: {
    type: String,
    enum: ["text", "image", "video"],
    default: "text",
  },
  answers: [{
    answer: {
      type: String,
      trim: true,
      required: true,
    },
    correct: {
      type: Boolean,
      default: false,
      required: true,
    },
    description : {
      type : mongoose.Schema.Types.Mixed
    }
  }],
  explanation: {
    type: String,
    trim: true,
  },
  difficultyLevel: {
    type: String,
    enum: ["Easy", "Medium", "Hard"],
    default: "Medium",
  },
  tags: [{
    type: String,
    trim: true,
  }],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
  },
  deletedAt : {
    type : Date
  }
});

// Indexes for optimized querying
QuizQuestionSchema.index({ question: "text", tags: "text" });

export default mongoose.model("QuizQuestion", QuizQuestionSchema);
