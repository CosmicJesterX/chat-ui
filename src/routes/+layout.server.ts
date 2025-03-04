import type { LayoutServerLoad } from "./$types";
import { collections } from "$lib/server/database";
import type { Conversation } from "$lib/types/Conversation";
import { UrlDependency } from "$lib/types/UrlDependency";
import { defaultModel, models } from "$lib/server/models";
import { authCondition } from "$lib/server/auth";
import { ObjectId } from "mongodb";
import type { ConvSidebar } from "$lib/types/ConvSidebar";
import { toolFromConfigs } from "$lib/server/tools";
import { MetricsServer } from "$lib/server/metrics";
import type { ToolFront, ToolInputFile } from "$lib/types/Tool";
import { base } from "$app/paths";
import { jsonSerialize } from "../lib/utils/serialize";
import type { FeatureFlags, GETModelsResponse } from "$lib/server/api/routes/groups/misc";
import type { UserGETFront, UserGETSettings } from "$lib/server/api/routes/groups/user";
import type { GETOldModelsResponse } from "$lib/server/api/routes/groups/misc";
export const load: LayoutServerLoad = async ({ locals, depends, fetch }) => {
	depends(UrlDependency.ConversationList);

	const settings = await collections.settings.findOne(authCondition(locals));

	const assistantActive = !models.map(({ id }) => id).includes(settings?.activeModel ?? "");

	const assistant = assistantActive
		? await collections.assistants.findOne({
				_id: new ObjectId(settings?.activeModel),
			})
		: null;

	const nConversations = await collections.conversations.countDocuments(authCondition(locals));

	const conversations =
		nConversations === 0
			? Promise.resolve([])
			: fetch(`${base}/api/v2/conversations`)
					.then((res) => res.json())
					.then(
						(
							convs: Pick<Conversation, "_id" | "title" | "updatedAt" | "model" | "assistantId">[]
						) =>
							convs.map((conv) => ({
								...conv,
								updatedAt: new Date(conv.updatedAt),
							}))
					);

	const userAssistants = settings?.assistants?.map((assistantId) => assistantId.toString()) ?? [];
	const userAssistantsSet = new Set(userAssistants);

	const assistants = conversations.then((conversations) =>
		collections.assistants
			.find({
				_id: {
					$in: [
						...userAssistants.map((el) => new ObjectId(el)),
						...(conversations.map((conv) => conv.assistantId).filter((el) => !!el) as ObjectId[]),
					],
				},
			})
			.toArray()
	);

	const toolUseDuration = (await MetricsServer.getMetrics().tool.toolUseDuration.get()).values;

	const configToolIds = toolFromConfigs.map((el) => el._id.toString());

	let activeCommunityToolIds = (settings?.tools ?? []).filter(
		(key) => !configToolIds.includes(key)
	);

	if (assistant) {
		activeCommunityToolIds = [...activeCommunityToolIds, ...(assistant.tools ?? [])];
	}

	const communityTools = await collections.tools
		.find({ _id: { $in: activeCommunityToolIds.map((el) => new ObjectId(el)) } })
		.toArray()
		.then((tools) =>
			tools.map((tool) => ({
				...tool,
				isHidden: false,
				isOnByDefault: true,
				isLocked: true,
			}))
		);

	return {
		nConversations,
		conversations: await conversations.then(
			async (convs) =>
				await Promise.all(
					convs.map(async (conv) => {
						if (settings?.hideEmojiOnSidebar) {
							conv.title = conv.title.replace(/\p{Emoji}/gu, "");
						}

						// remove invalid unicode and trim whitespaces
						conv.title = conv.title.replace(/\uFFFD/gu, "").trimStart();

						let avatarUrl: string | undefined = undefined;

						if (conv.assistantId) {
							const hash = (
								await collections.assistants.findOne({
									_id: new ObjectId(conv.assistantId),
								})
							)?.avatar;
							if (hash) {
								avatarUrl = `/settings/assistants/${conv.assistantId}/avatar.jpg?hash=${hash}`;
							}
						}

						return {
							id: conv._id.toString(),
							title: conv.title,
							model: conv.model ?? defaultModel,
							updatedAt: conv.updatedAt,
							assistantId: conv.assistantId?.toString(),
							avatarUrl,
						} satisfies ConvSidebar;
					})
				)
		),
		models: await fetch(`${base}/api/v2/models`).then(
			(res) => res.json() as Promise<GETModelsResponse>
		),
		oldModels: await fetch(`${base}/api/v2/models/old`).then(
			(res) => res.json() as Promise<GETOldModelsResponse>
		),
		tools: [...toolFromConfigs, ...communityTools]
			.filter((tool) => !tool?.isHidden)
			.map(
				(tool) =>
					({
						_id: tool._id.toString(),
						type: tool.type,
						displayName: tool.displayName,
						name: tool.name,
						description: tool.description,
						mimeTypes: (tool.inputs ?? [])
							.filter((input): input is ToolInputFile => input.type === "file")
							.map((input) => (input as ToolInputFile).mimeTypes)
							.flat(),
						isOnByDefault: tool.isOnByDefault ?? true,
						isLocked: tool.isLocked ?? true,
						timeToUseMS:
							toolUseDuration.find(
								(el) => el.labels.tool === tool._id.toString() && el.labels.quantile === 0.9
							)?.value ?? 15_000,
						color: tool.color,
						icon: tool.icon,
					}) satisfies ToolFront
			),
		communityToolCount: await fetch(`${base}/api/v2/tools/count`).then(
			(res) => res.json() as Promise<number>
		),
		assistants: assistants.then((assistants) =>
			assistants
				.filter((el) => userAssistantsSet.has(el._id.toString()))
				.map((el) => ({
					...el,
					_id: el._id.toString(),
					createdById: undefined,
					createdByMe:
						el.createdById.toString() === (locals.user?._id ?? locals.sessionId).toString(),
				}))
		),
		assistant: assistant ? jsonSerialize(assistant) : undefined,
		user: await fetch(`${base}/api/v2/user`).then((res) => res.json() as Promise<UserGETFront>),
		settings: await fetch(`${base}/api/v2/user/settings`).then(
			(res) => res.json() as Promise<UserGETSettings>
		),
		...(await fetch(`${base}/api/v2/feature-flags`).then(
			(res) => res.json() as Promise<FeatureFlags>
		)),
	};
};
