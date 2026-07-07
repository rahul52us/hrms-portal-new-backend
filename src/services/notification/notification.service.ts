import NotificationSchema from '../../schemas/Notification/notification.schema'

export const createNotification = async(data : any) => {
    try
    {
        const notify = NotificationSchema(data)
        const savedNotify = await notify.save()
        return {
            status : 'success',
            data : savedNotify,
            message : 'Notifition Has been created Successful'
        }
    }
    catch(err : any)
    {
        return {
            status : 'error',
            data : err?.message,
            message : err?.message
        }
    }
}

export const markNotificationAsRead = async (req: any, res: any) => {
  try {
    const { _id } = req.body;

    const updatedNotification = await NotificationSchema.findByIdAndUpdate(
      _id,
      { isRead: true, readAt: new Date() },
      { new: true }
    );

    if (!updatedNotification) {
      return res.status(404).send({
        status: 'error',
        data: null,
        message: 'Notification not found',
      });
    }

    return res.status(200).send({
      status: 'success',
      data: updatedNotification,
      message: 'Notification marked as read successfully',
    });
  } catch (err: any) {
    return res.status(500).send({
      status: 'error',
      data: err?.message,
      message: err?.message,
    });
  }
};

export const getNotification = async (req: any, res: any) => {
  try {
    const filter: any = {};

    if (req.query.read === 'true') {
      filter.isRead = true;
    } else if (req.query.read === 'false') {
      filter.isRead = false;
    }

    // Pagination values
    const page = parseInt(req.query.page) || 1; // Default page 1
    const limit = parseInt(req.query.limit) || 10; // Default limit 10
    const skip = (page - 1) * limit;

    const [notifications, totalCount] = await Promise.all([
      NotificationSchema.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      NotificationSchema.countDocuments(filter),
    ]);

    return res.status(200).send({
      status: 'success',
      data: notifications,
      totalPages: Math.ceil(totalCount / limit),
      message: 'Notifications fetched successfully',
    });
  } catch (err: any) {
    res.status(500).send({
      status: 'error',
      data: err?.message,
      message: err?.message,
    });
  }
};



