import mongoose from "mongoose";

const orderSchema = new mongoose.Schema({
  type: {
    type: String,
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required : true
  },
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Company",
    required : true
  },
  orderReferenceId: {
    type: mongoose.Schema.Types.ObjectId,
  },
  title: {
    type: String,
  },
  description: {
    type: String
  },
  image : {
    type : String
  },
  price: {
    type: String
  },
  quantity: {
    type: Number
  },
  details : {
    type : mongoose.Schema.Types.Mixed
  },
  is_active : {
    type : Boolean,
    default : true
  },
  created_At: {
    type: Date
  },
  updated_At : {
    type : Date
  }
});

export default mongoose.model("Order", orderSchema);