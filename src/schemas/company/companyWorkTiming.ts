import mongoose, { Document } from "mongoose";


const companyWorkTiming = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref:'Company'
  },
  createdBy:{
    type : mongoose.Schema.Types.ObjectId,
    ref : 'User'
  },
  policy : {
    type : mongoose.Schema.Types.ObjectId,
    ref : 'CompanyPolicy'
  },
  startTime : {
    type : String,
    required : true
  },
  endTime : {
    type : String,
    required : true
  },
  daysOfWeek : {
    type : [String],
    required : true
  },
  is_active : {
    type : Boolean,
    default : true
  },
  deletedAt: {
    type: Date,
  },
  createdAt: {
    type: Date,
    default: new Date(),
  },
  updatedAt: {
    type: Date,
  },
});

export default mongoose.model("workTiming", companyWorkTiming);
