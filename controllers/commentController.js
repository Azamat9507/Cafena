const Comment = require("../schema/commentModel");

// Create a new comment
exports.retrieveComment = async (req, res) => {
  try {
    const { name, comment, rating, productId } = req.body;

    const newComment = new Comment({
      name,
      comment,
      rating,
      product: productId,
    });

    await newComment.save();

    res.status(201).json(newComment);
  } catch (error) {
    res.status(500).json({ error: "Failed to create comment" });
  }
};


// Retrieve all comments
exports.getComments = async (req, res) => {
  try {
    const { productId } = req.query;
    let comments;

    if (productId) {
      comments = await Comment.find({ product: productId });
    } else {
      comments = await Comment.find();
    }

    res.status(200).json(comments);
  } catch (error) {
    res.status(500).json({ error: "Failed to retrieve comments" });
  }
};

// Delete a comment by name and comment
// exports.delete = async (req, res) => {
//   try {
//     const productId = req.params.productId;

//     const deletedComments = await Comment.deleteOne({ product: productId });

//     if (deletedComments.deletedCount > 0) {
//       res.json({ message: 'Comments deleted successfully' });
//     } else {
//       res.status(404).json({ error: 'No comments found for the product' });
//     }
//   } catch (error) {
//     console.error(error);
//     res.status(500).json({ error: 'Failed to delete comments' });
//   }
// };

