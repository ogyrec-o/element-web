/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/
import type { Client as ClientApi, AccountDataApi } from "@element-hq/element-web-module-api";
import type { MatrixClient, Room } from "matrix-js-sdk/src/matrix";
import { SdkContextClass } from "../contexts/SDKContext";

function getSafeCli(): MatrixClient {
    const cli = SdkContextClass.instance.client;
    if (!cli) {
        throw new Error("Could not get MatrixClient from SdkContextClass");
    }
    return cli;
}

class AccountData implements AccountDataApi {
    public get(eventType: string): unknown {
        //@ts-expect-error
        return getSafeCli().getAccountData(eventType)?.getContent();
    }

    public async set(eventType: string, content: any): Promise<void> {
        //@ts-expect-error
        await getSafeCli().setAccountData(eventType, content);
    }

    public async delete(eventType: string): Promise<void> {
        //@ts-expect-error
        getSafeCli().deleteAccountData(eventType);
    }
}

export class Client implements ClientApi {
    private accountDataApi?: AccountData;

    public getRoom(roomId: string): Room | null {
        return getSafeCli().getRoom(roomId);
    }

    public getAccountDataApi(): AccountDataApi {
        if (!this.accountDataApi) {
            this.accountDataApi = new AccountData();
        }
        return this.accountDataApi;
    }
}
