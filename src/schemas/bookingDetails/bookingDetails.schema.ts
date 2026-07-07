import mongoose from "mongoose";

const bookingDetailsSchema = new mongoose.Schema({
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
  details : {
    type : mongoose.Schema.Types.Mixed,
    default : {}
  },
  createdAt: {
    type: Date,
    default: new Date(),
  },
});

export default mongoose.model("BookingDetails", bookingDetailsSchema);
