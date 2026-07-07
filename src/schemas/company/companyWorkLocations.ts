import mongoose, { Document } from "mongoose";

const companyHolidays = new mongoose.Schema({
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
  ipAddress : {
    type : String,
    required : true
  },
  locationName : {
    type : String,
    required : true
  },
  ipAddressRange : {
    type : mongoose.Schema.Types.Mixed
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

export default mongoose.model("WorkLocations", companyHolidays);
