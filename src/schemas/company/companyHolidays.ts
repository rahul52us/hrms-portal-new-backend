import mongoose, { Document } from "mongoose";

const companyHolidays = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref:'Company'
  },
  policy : {
    type : mongoose.Schema.Types.ObjectId,
    ref : 'CompanyPolicy'
  },
  createdBy:{
    type : mongoose.Schema.Types.ObjectId,
    ref : 'User'
  },
  date : {
    type : Date,
    required : true
  },
  title : {
    type : String,
    required : true
  },
  description : {
    type : String
  },
  is_active : {
    type : Boolean
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

export default mongoose.model("Holidays", companyHolidays);
