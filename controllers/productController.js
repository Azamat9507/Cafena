const Product = require("../models/Product");
const assert = require("assert");
const Definer = require("../lib/mistake");

let productController = module.exports;
//for test

productController.getAllProducts = async (req, res) => {
  try {
    console.log("POST cont/getAllProducts");
    const product = new Product();
    const result = await product.getAllProductsData(req.member, req.body);
    res.json({ state: "success", data: result });
  } catch (err) {
    console.log(`ERROR, cont/getAllProducts, ${err.message}`);
    res.json({ state: "failed", message: err.message });
  }
};

productController.getChosenProduct = async (req, res) => {
  try {
    console.log("GET cont/getChosenProduct");
    const product = new Product(), 
      id = req.params.id,
      result = await product.getChosenProductData(req.member, id);
    res.json({ state: "success!", data: result });
  } catch(err) {
    console.log(`ERROR, cont/getChosenProduct, ${err.message}`);
    res.json({ state: "failed", message: err.message });
  }
};

/*****************************
 *   BSSSR RELATED METHODS  *
 * **************************/

productController.addNewProduct = async (req, res) => {
  try {
    console.log("POST: cont/addNewProduct");
    assert(req.files, Definer.general_err3); // try & catch sifatida ishlaydi
    const product = new Product();
    let data = req.body;
    

    data.product_images = req.files.map((ele) => {
      return ele.path; //har bir fayl qaerga yuklanganligini ko'rsatadi
    });

    const result = await product.addNewProductData(data, req.member);

    // console.log(data) // shows path
    const html = `<script>alert('new dish added successfully');
    window.location.replace('/resto/products/menu') 
    </script>`;
    res.end(html);
  } catch (err) {
    console.log(`ERROR cont/addNewProduct, ${err.message}`);
  }
};
productController.updateChosenProduct = async (req, res) => {
  try {
    console.log("POST: cont/updateChosenProduct");
    const product = new Product();
    const id = req.params.id;
    const result = await product.updateChosenProductData(
      id,
      req.body,
      req.member._id
    );
    await res.json({state: "success", data: result});
  } catch(err) {
    console.log(`ERROR, cont/updateChosenProduct, ${err.message}`);
    res.json({state: "fail", message: err.message });
  }
};

