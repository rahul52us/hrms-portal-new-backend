import mongoose from "mongoose";

const contactSchema = new mongoose.Schema({
  name: {
    type: String,
  },
  company : {
    type : String,
    ref : 'Company'
  },
  phone: {
    type: String,
  },
  inquiryType : {
    type : String
  },
  email: {
    type: String,
  },
  hearFrom: {
    type: String,
  },
  otherDetails : {
    type : mongoose.Schema.Types.Mixed
  },
  description: {
    type: String,
  },
  createdAt: {
    type: Date,
    default: new Date(),
  },
});

export default mongoose.model("Contact", contactSchema);
