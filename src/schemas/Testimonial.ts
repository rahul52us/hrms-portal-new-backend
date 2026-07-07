import mongoose, { Document } from "mongoose";

interface TestimonialI extends Document {
  name: string;
  user: mongoose.Schema.Types.ObjectId;
  profession:string;
  company: mongoose.Schema.Types.ObjectId;
  image: any;
  rating:number;
  description: string;
}

const TestimonialSchema = new mongoose.Schema<TestimonialI>(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "User is required"],
    },
    company : {
      type : mongoose.Schema.Types.ObjectId,
      ref : 'Company',
      required: [true, "Organisation is required"],
    },
    rating: {
      type : Number,
      default : 3
    },
    name: {
      type: String,
      trim: true,
    },
    profession:{
      type : String,
      trim:true
    },
    description: {
      type: String,
      trim: true,
    },
    image: {
      name: {
        type: String,
      },
      url: {
        type: String,
      },
      type: {
        type: String,
      },
    },
  },
  { timestamps: true }
);

export default mongoose.model<TestimonialI>("Testimonial", TestimonialSchema);
