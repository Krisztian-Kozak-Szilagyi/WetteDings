const { Schema, model } = require('mongoose');

const userSchema = new Schema(
  {
    username: { type: String, required: true, trim: true },
    usernameLower: { type: String, required: true, unique: true },
    email: { type: String, required: true, lowercase: true, trim: true, unique: true },
    passwordHash: { type: String, required: true },
    // Kontostand in Cent
    balance: { type: Number, required: true, min: 0 },
  },
  { timestamps: true }
);

userSchema.index({ balance: -1 });

module.exports = model('User', userSchema);
