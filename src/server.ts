import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { StreamChat } from "stream-chat";
import { GoogleGenAI } from "@google/genai";
import { prisma } from "./db/prisma";

dotenv.config();

const app = express();

app.use(
	cors({
		origin: "https://chat-ai-ui-azure.vercel.app/",
		credentials: true,
	})
);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

//Init Stream Chat
const chatClient = StreamChat.getInstance(
	process.env.STREAM_API_KEY!,
	process.env.STREAM_API_SECRET!
);

//Init OpenAi
const ai = new GoogleGenAI({
	apiKey: process.env.GEMINI_API_KEY,
});

// Register user with Stream Chat
app.post(
	"/register-user",
	async (req: Request, res: Response): Promise<any> => {
		const { name, email } = req.body;

		if (!name || !email) {
			return res
				.status(400)
				.json({ error: "Name and email are required" });
		}

		try {
			const userId = email.replace(/[^a-zA-Z0-9_-]/g, "_");

			//Check if user exists
			const clientResponse = await chatClient.queryUsers({
				id: { $eq: userId },
			});

			if (!clientResponse.users.length) {
				await chatClient.upsertUser({
					id: userId,
					name: name,
					role: "user",
				});
			}

			//Check for exisitng user in db
			const existingUser = await prisma.user.findUnique({
				where: {
					id: userId,
				},
			});

			if (!existingUser) {
				await prisma.user.create({
					data: {
						id: userId,
						email,
						name,
						role: "user",
					},
				});
			}

			res.status(200).json({ userId, name, email });
		} catch (error) {
			res
				.status(500)
				.json({ error: "Internal Server Error" });
		}
	}
);

//Send message to AI
app.post(
	"/chat",
	async (req: Request, res: Response): Promise<any> => {
		const { message, userId } = req.body;

		if (!message || !userId) {
			return res
				.status(400)
				.json({ error: "Message and user are required" });
		}

		try {
			const userResponse = await chatClient.queryUsers({
				id: userId,
			});

			if (!userResponse.users.length) {
				return res.status(404).json({
					error: "User not found, please, register first",
				});
			}

			//Check for exisitng user in db
			const existingUser = await prisma.user.findUnique({
				where: {
					id: userId,
				},
			});

			if (!existingUser) {
				return res.status(404).json({
					error: "User is not found, please register",
				});
			}

			//Fetch users past message context
			const pastMessages = await prisma.chat.findMany({
				where: {
					userId,
				},
				select: {
					message: true,
					reply: true,
				},
				orderBy: {
					createdAt: "desc",
				},
				take: 10,
			});

			//Format chat history for Gen AI
			const conversation = pastMessages.flatMap((chat) => [
				{
					role: "user",
					parts: [{ text: chat.message }],
				},
				{
					role: "model",
					parts: [{ text: chat.reply }],
				},
			]);

			//Add latest user messages to the converstaion
			conversation.push({
				role: "user",
				parts: [{ text: message }],
			});

			//Send message to GenAi
			const response = await ai.models.generateContent({
				model: "gemini-2.0-flash",
				contents: conversation,
				config: {
					systemInstruction:
						"You are a helpful assistant who answers briefly replying on the previous context.",
				},
			} as any);

			const aiMessage: string =
				response?.candidates?.[0]?.content?.parts
					?.map((part: any) => part.text)
					.join("") || "No reply from AI";

			//Create chat in db
			await prisma.chat.create({
				data: {
					userId,
					message,
					reply: aiMessage,
				},
			});

			//Create channel
			const channel = chatClient.channel(
				"messaging",
				`chat-${userId}`,
				{
					name: "AI chat",
					created_by_id: "ai_bot",
				} as any
			);

			await channel.create();
			await channel.sendMessage({
				text: aiMessage,
				user_id: "ai_bot",
			});

			return res.status(200).json({ reply: aiMessage });
		} catch (error) {
			return res
				.status(500)
				.json({ error: `Internal Server Error: ${error}` });
		}
	}
);

//Get chat history
app.post(
	"/chat-history",
	async (req: Request, res: Response): Promise<any> => {
		const { userId } = req.body;

		if (!userId) {
			return res
				.status(404)
				.json({ error: "user id is requried" });
		}
		try {
			const chatHistory = await prisma.chat.findMany({
				where: {
					userId,
				},
				select: {
					message: true,
					reply: true,
				},
			});

			return res
				.status(200)
				.json({ messages: chatHistory });
		} catch (error) {
			return res
				.status(500)
				.json({ error: `Internal Server Error: ${error}` });
		}
	}
);

const PORT = (process.env.PORT || 5000) as number;

app.listen(PORT, "localhost", () =>
	console.log(`Server is running on ${PORT}`)
);
