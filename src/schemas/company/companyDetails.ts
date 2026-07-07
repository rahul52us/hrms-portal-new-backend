import mongoose, { Document } from "mongoose";


const companyDetails = new mongoose.Schema<any>({
   company : {
    type : mongoose.Schema.Types.ObjectId,
    ref : 'Company'
   },
   faq : {
    type : mongoose.Schema.Types.Mixed,
    default : []
   },
   homeFaq:{
    type : mongoose.Schema.Types.Mixed,
    default : []
   },
   details : {
    type : mongoose.Schema.Types.Mixed,
    defailt : {}
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

export default mongoose.model<any>("CompanyDetails", companyDetails);
