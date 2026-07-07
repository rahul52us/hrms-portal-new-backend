// models/Test.ts
import mongoose, { Schema, Document } from 'mongoose';

export interface IQuestion {
  question: string;
  options: string[];
  correctOptionIndex: number;
  explanation?: string;
}

export interface IResultDescription {
  minScore: number;
  maxScore: number;
  message: string;
}

export interface ITest extends Document {
  title: string;
  description: string;
  marksPerQuestion: number;
  timeLimitInMinutes?: number;
  shuffleQuestions?: boolean;
  shuffleOptions?: boolean;
  tags?: string[];
  difficulty?: 'easy' | 'medium' | 'hard';
  questions: IQuestion[];
  resultDescriptions: IResultDescription[];
  createdAt: Date;
  updatedAt: Date;
}

const QuestionSchema = new Schema<IQuestion>({
  question: { type: String, required: true },
  options: { type: [String], required: true },
  correctOptionIndex: { type: Number, required: true },
  explanation: { type: String }
});

const ResultDescriptionSchema = new Schema<IResultDescription>({
  minScore: { type: Number, required: true },
  maxScore: { type: Number, required: true },
  message: { type: String, required: true }
});

const TestSchema = new Schema<ITest>({
  title: { type: String, required: true },
  description: { type: String, required: true },
  marksPerQuestion: { type: Number, required: true },
  timeLimitInMinutes: { type: Number },
  shuffleQuestions: { type: Boolean, default: false },
  shuffleOptions: { type: Boolean, default: false },
  tags: { type: [String] },
  difficulty: { type: String, enum: ['easy', 'medium', 'hard'] },
  questions: { type: [QuestionSchema], required: true },
  resultDescriptions: { type: [ResultDescriptionSchema], required: true }
}, { timestamps: true });

export const TestModel = mongoose.model<ITest>('Test', TestSchema);