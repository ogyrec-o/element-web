/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React from "react";
import { type RoomViewProps, type BuiltinsApi } from "@element-hq/element-web-module-api";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import { RoomView } from "../components/structures/RoomView";
import { SdkContextClass } from "../contexts/SDKContext";
import RoomAvatar from "../components/views/avatars/RoomAvatar";

function getSafeCli(): MatrixClient {
    const cli = SdkContextClass.instance.client;
    if (!cli) {
        throw new Error("Could not get MatrixClient from SdkContextClass");
    }
    return cli;
}

export class ElementWebBuiltinsApi implements BuiltinsApi {
    public getRoomViewComponent(): React.ComponentType<RoomViewProps> {
        return RoomView;
    }

    public renderRoomView(roomId: string): React.ReactNode {
        return <RoomView roomId={roomId} />;
    }

    public renderRoomAvatar(roomId: string, size?: string): React.ReactNode {
        const room = getSafeCli().getRoom(roomId);
        if (!room) {
            throw new Error(`No room such room: ${roomId}`);
        }
        return <RoomAvatar room={room} size={size} />;
    }
}
