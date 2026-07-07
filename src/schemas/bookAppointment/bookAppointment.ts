import mongoose from "mongoose";

const bookAppointment = new mongoose.Schema({
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
  emergencyNumber : {
    type :String
  },
  emergencyContactName : {
    type :String
  },
  assignTo : {
    type : String
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

export default mongoose.model("bookAppointment", bookAppointment);
