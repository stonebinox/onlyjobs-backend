import User from "../models/User";

export const findUserByEmail = async (email: string) => {
  return User.findOne({ email });
};
