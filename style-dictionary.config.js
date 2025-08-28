// style-dictionary.config.js
module.exports = {
  source: ["tokens/**/*.json"],
  platforms: {
    css: {
      transformGroup: "css",
      buildPath: "public/dist/",   // Firebase hosting will serve from public/
      files: [
        {
          destination: "brand.css",
          format: "css/variables",
          options: {
            outputReferences: true   // Allows references between tokens
          }
        }
      ]
    }
  }
};