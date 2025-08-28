module.exports = {
  source: ["tokens/**/*.json"],
  platforms: {
    css: {
      transformGroup: "css",
      buildPath: "dist/",
      files: [
        {
          destination: "brand.css",
          format: "css/variables"
        }
      ]
    }
  }
};