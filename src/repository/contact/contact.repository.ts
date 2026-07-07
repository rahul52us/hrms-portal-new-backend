import { createNotification } from "../../services/notification/notification.service";
import Contact from "../../schemas/contact/contact.schema";

export const createContact = async (data: any) => {
  try {

    const contactDetails = new Contact(data);
    const savedContactDetails = await contactDetails.save();

    const parts = [];

    if (data.name) parts.push(`Name: ${data.name}`);
    if (data.phone) parts.push(`Phone: ${data.phone}`);
    if (data.email) parts.push(`Email: ${data.email}`);

    const message = `New contact added. ${parts.join(", ")}`;

    const dts = await createNotification({
      type: "contact",
      message,
    });

    return {
      status: "success",
      data: savedContactDetails,
      message: "Contact Details have been saved successfully",
      statusCode: 200,
    };
  } catch (err: any) {
    return {
      status: "error",
      data: err?.message,
      message: err?.message,
      statusCode: 500,
    };
  }
};

export const getContacts = async (
  search: string,
  page: number,
  limit: number,
  company: any
) => {
  try {
    const skip = (page - 1) * limit;

    const query: any = {};

    if (search) {
      query.$or = [
        { phone: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { hearFrom: { $regex: search, $options: "i" } },
        { inquiryType: { $regex: search, $options: "i" } },
      ];
    }

    const contacts = await Contact.find(query)
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 });

    const totalContacts = await Contact.countDocuments(query);

    return {
      status: "success",
      data: contacts,
      totalPages: Math.ceil(totalContacts / limit),
      message: "Contacts fetched successfully",
      statusCode: 200,
    };
  } catch (err: any) {
    return {
      status: "error",
      data: err?.message,
      message: err?.message,
      statusCode: 500,
    };
  }
};
