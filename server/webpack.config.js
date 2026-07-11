const path = require("path");

module.exports = {
  target: "node",
  mode: "production",
  entry: "./src/index.ts",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "server.js",
    clean: true,
  },
  resolve: {
    extensions: [".ts", ".js", ".json"],
    alias: {
      "@shared": path.resolve(__dirname, "../shared"),
    },
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: "ts-loader",
        exclude: /node_modules/,
      },
    ],
  },
  externals: {
    "@prisma/client": "commonjs @prisma/client",
    mysql2: "commonjs mysql2",
  },
  node: {
    __dirname: false,
    __filename: false,
  },
};
