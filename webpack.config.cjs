const path = require('node:path');

module.exports = {
  mode: 'production',
  target: 'node18',
  entry: './src/index.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'sxml.js',
    library: {
      type: 'commonjs2',
    },
    clean: false,
  },
  devtool: false,
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: {
          loader: 'ts-loader',
          options: {
            transpileOnly: true,
            compilerOptions: {
              declaration: false,
            },
          },
        },
        exclude: /node_modules/,
      },
    ],
  },
  optimization: {
    minimize: false,
  },
};
