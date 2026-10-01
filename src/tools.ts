const optionalDeviceIdProp = {
  deviceId: {
    type: "string",
    description:
      "Optional deviceId to target a specific phone belonging to your VISION account. Defaults to your primary connected device.",
  },
};

export const tools = [
  {
    name: "device.list",
    description:
      "Returns all Android devices belonging to the authenticated VISION account (resolved via Google OpenID Connect sub -> users.id -> devices.user_id) and their live connection status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "notifications.get_unread",
    description: "Fetches all unread Android notifications from the device.",
    inputSchema: {
      type: "object",
      properties: { ...optionalDeviceIdProp },
    },
  },
  {
    name: "phone.notification",
    description: "Takes an action, id, and optional replyText to interact with a notification.",
    inputSchema: {
      type: "object",
      properties: {
        ...optionalDeviceIdProp,
        action: { type: "string", enum: ["dismiss", "reply", "open"] },
        id: { type: "string" },
        replyText: { type: "string" },
      },
      required: ["action", "id"],
    },
  },
  {
    name: "phone.screenshot",
    description: "Captures a screenshot of the current Android device screen and returns it as a Base64 JPEG string.",
    inputSchema: {
      type: "object",
      properties: { ...optionalDeviceIdProp },
    },
  },
  {
    name: "phone.open_app",
    description: "Launches an Android application.",
    inputSchema: {
      type: "object",
      properties: {
        ...optionalDeviceIdProp,
        packageName: { type: "string", description: "e.g. com.whatsapp" },
      },
      required: ["packageName"],
    },
  },
  {
    name: "phone.tap",
    description: "Taps the screen by text, contentDescription, or exact coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        ...optionalDeviceIdProp,
        text: { type: "string" },
        contentDescription: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
      },
    },
  },
  {
    name: "phone.tap_sequence",
    description: "Executes a rapid sequence of physical screen taps in one single operation.",
    inputSchema: {
      type: "object",
      properties: {
        ...optionalDeviceIdProp,
        sequence: {
          type: "string",
          description: "Stringified JSON array of tap objects e.g. [{\"x\":120,\"y\":500},{\"x\":450,\"y\":600}]",
        },
      },
      required: ["sequence"],
    },
  },
  {
    name: "phone.type",
    description: "Instantly types a full string of text into the currently focused input field.",
    inputSchema: {
      type: "object",
      properties: {
        ...optionalDeviceIdProp,
        text: { type: "string" },
      },
      required: ["text"],
    },
  },
  {
    name: "phone.scroll",
    description: "Scrolls the screen.",
    inputSchema: {
      type: "object",
      properties: {
        ...optionalDeviceIdProp,
        direction: { type: "string", enum: ["forward", "backward", "up", "down"] },
      },
      required: ["direction"],
    },
  },
  {
    name: "phone.swipe",
    description: "Executes a physical swipe/drag gesture on the screen from a starting point to an ending point. Useful for 360-degree scrolling, swiping left/right, or dragging and dropping.",
    inputSchema: {
      type: "object",
      properties: {
        ...optionalDeviceIdProp,
        startX: { type: "number", description: "The X coordinate where the swipe begins" },
        startY: { type: "number", description: "The Y coordinate where the swipe begins" },
        endX: { type: "number", description: "The X coordinate where the swipe ends" },
        endY: { type: "number", description: "The Y coordinate where the swipe ends" },
        duration: { type: "number", description: "The duration of the swipe in milliseconds (default: 500)" },
      },
      required: ["startX", "startY", "endX", "endY"],
    },
  },
  {
    name: "phone.get_screen_text",
    description: "Extracts all visible text on the current screen, along with the precise coordinates (bounds and center [X, Y]) of each text element. This is an extremely powerful fallback for finding exact coordinates to click on when screenshots are unavailable or failing.",
    inputSchema: {
      type: "object",
      properties: { ...optionalDeviceIdProp },
      required: [],
    },
  },
  {
    name: "phone.back",
    description: "Presses the Android system back button.",
    inputSchema: {
      type: "object",
      properties: { ...optionalDeviceIdProp },
    },
  },
  {
    name: "phone.home",
    description: "Presses the Android system home button.",
    inputSchema: {
      type: "object",
      properties: { ...optionalDeviceIdProp },
    },
  },
];
