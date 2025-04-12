import User from "../models/User";

export const findUserByEmail = async (email: string) => {
  return User.findOne({ email });
};

export const getUserNameById = async (id: string) => {
  const user = await User.findOne({ _id: id });

  if (user) {
    return user.name || user.email;
  }

  return "-";
};
