# Amazon MCP Server

This server allows you to interact with Amazon's services using the MCP (Model Context Protocol) framework. This lets you use your Amazon account through ChatGPT or Claude AI interfaces.

## Features

- **Product search**: Search for products on Amazon
- **Product details**: Retrieve detailed information about a specific product on Amazon
- **Cart management**: Add items or clear your Amazon cart
- **Ordering**: Start a real checkout, submit a BLIK code, and confirm the paid order appears in Amazon history
- **Orders history**: Retrieve your recent Amazon orders details

## Demo

Simple demo, showcasing a quick product search and purchase.

![Demo GIF video](./demo.gif)

## Full Demo

Another more complex demo with products search, leveraging Claude AI recommendations to compare and make a decision, then purchase.

It showcases how natural and powerful the Amazon MCP integration could be inside a conversation

Video: https://www.youtube.com/watch?v=xas2CLkJDYg

## Install

Install dependencies

```sh
npm install -D
```

Build the project

```sh
npm run build
```

## Claude Desktop Integration

Create or update `~/Library/Application Support/Claude/claude_desktop_config.json` with the path to the MCP server.

```json
{
  "mcpServers": {
    "amazon": {
      "command": "node",
      "args": ["/Users/admin/dev/mcp-server-amazon/build/index.js"],
      "env": {
        "AMAZON_EMAIL": "your-amazon-login@example.com",
        "AMAZON_PASSWORD": "your-amazon-password",
        "AMAZON_DOMAIN": "amazon.pl"
      }
    }
  }
}
```

Restart the Claude Desktop app to apply the changes. You should now see the Amazon MCP server listed in the Claude Desktop app.

The server can still use `amazonCookies.json` directly, but if cookies are missing or expired it can now regenerate them automatically from the configured login and password.

## Purchase Flow

1. Run `perform-purchase` after confirming the cart contents.
2. The server will move checkout to the BLIK payment step and return `awaiting_blik_code`.
3. Run `submit-blik-code` with the 6-digit code.
4. If Amazon already exposes the order in history, the server returns `paid_confirmed`.
5. If Amazon is still processing, run `confirm-purchase-paid` later.

|                                  |                                    |
| :------------------------------: | :--------------------------------: |
| ![screenshot](./screenshot.webp) | ![screenshot2](./screenshot2.webp) |

## Troubleshooting

The MCP server logs its output to a file. If you encounter any issues, you can check the log file for more information.

See `~/Library/Logs/Claude/mcp-server-amazon.log`

## License

[The MIT license](./LICENSE)
