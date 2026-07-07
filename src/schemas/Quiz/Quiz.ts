import mongoose from "mongoose";

const QuizQuestionSchema = new mongoose.Schema({
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "QuizCategory"
  },
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
  deletedAt:{
    type : Date
  }
});

QuizQuestionSchema.index({ question: "text", tags: "text" });

export default mongoose.model("Quiz", QuizQuestionSchema);