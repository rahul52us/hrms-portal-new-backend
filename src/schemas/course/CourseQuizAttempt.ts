import mongoose, { Document, Schema } from "mongoose";

export type CourseQuizScope = "module" | "final";

export interface ICourseQuizAttemptAnswer {
  questionId: string;
  question: string;
  selectedOptionId: string;
  selectedOptionLabel: string;
  selectedAnswerText: string;
  correctOptionId: string;
  correctOptionLabel: string;
  correctAnswerText: string;
  isCorrect: boolean;
  marksAwarded: number;
  maxMarks: number;
}

export interface ICourseQuizAttempt extends Document {
  userId: mongoose.Types.ObjectId;
  courseId: mongoose.Types.ObjectId;
  quizId: string;
  quizTitle: string;
  scope: CourseQuizScope;
  moduleId: string;
  moduleTitle: string;
  score: number;
  maxScore: number;
  percentage: number;
  correctCount: number;
  incorrectCount: number;
  questionCount: number;
  attemptNumber: number;
  answers: ICourseQuizAttemptAnswer[];
  submittedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const CourseQuizAttemptAnswerSchema = new Schema<ICourseQuizAttemptAnswer>({
  questionId: { type: String, required: true, trim: true },
  question: { type: String, required: true, trim: true },
  selectedOptionId: { type: String, default: "", trim: true },
  selectedOptionLabel: { type: String, default: "", trim: true },
  selectedAnswerText: { type: String, default: "", trim: true },
  correctOptionId: { type: String, required: true, trim: true },
  correctOptionLabel: { type: String, required: true, trim: true },
  correctAnswerText: { type: String, required: true, trim: true },
  isCorrect: { type: Boolean, default: false },
  marksAwarded: { type: Number, default: 0, min: 0 },
  maxMarks: { type: Number, default: 1, min: 0 },
});

const CourseQuizAttemptSchema = new Schema<ICourseQuizAttempt>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    courseId: {
      type: Schema.Types.ObjectId,
      ref: "Course",
      required: true,
      index: true,
    },
    quizId: {
      type: String,
      required: true,
      trim: true,
    },
    quizTitle: {
      type: String,
      default: "",
      trim: true,
    },
    scope: {
      type: String,
      enum: ["module", "final"],
      required: true,
    },
    moduleId: {
      type: String,
      default: "",
      trim: true,
    },
    moduleTitle: {
      type: String,
      default: "",
      trim: true,
    },
    score: {
      type: Number,
      default: 0,
      min: 0,
    },
    maxScore: {
      type: Number,
      default: 0,
      min: 0,
    },
    percentage: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    correctCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    incorrectCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    questionCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    attemptNumber: {
      type: Number,
      default: 1,
      min: 1,
    },
    answers: {
      type: [CourseQuizAttemptAnswerSchema],
      default: [],
    },
    submittedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

CourseQuizAttemptSchema.index({ userId: 1, courseId: 1, quizId: 1 }, { unique: true });
CourseQuizAttemptSchema.index({ courseId: 1, updatedAt: -1 });

export default mongoose.model<ICourseQuizAttempt>("CourseQuizAttempt", CourseQuizAttemptSchema);
