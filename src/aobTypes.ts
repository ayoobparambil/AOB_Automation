export type DeployPayload = {
    recipient: string;
    accessCode: string;
    db4Type: string;
    reference: string;
    patient: {
        name: string;
        dob: string;
        mobile: string;
        medicareNo: string;
        medicareIrn: string;
        address: string;
    };
    location: {
        id: string;
        name: string;
        address: string;
    };
    provider: {
        name: string;
        number: string;
    };
    referrer: {
        name: string;
        number: string;
        date: string;
        period: string;
    };
    payee: {
        name: string;
        number: string;
        acrf: string;
    };
    services: Array<{
        date: string;
        itemNo: string;
        benefitAssigned: string;
        description: string;
    }>;
    agreementDate: string;
};

export type DeployCsvRow = {
    DeployRowNumber: string;
    TenantRowIndex: string;
    TenantId: string;
    APIKey: string;
    recipientName: string;
    accessCode: string;
    db4Type: string;
    reference: string;
    patientName: string;
    patientDob: string;
    patientMobile: string;
    patientMedicareNo: string;
    patientMedicareIrn: string;
    patientAddress: string;
    locationId: string;
    locationName: string;
    locationAddress: string;
    providerName: string;
    providerNumber: string;
    referrerName: string;
    referrerNumber: string;
    referrerDate: string;
    referrerPeriod: string;
    payeeName: string;
    payeeNumber: string;
    payeeAcrf: string;
    serviceDate: string;
    serviceItemNo: string;
    serviceBenefitAssigned: string;
    serviceDescription: string;
    agreementDate: string;
    payloadJson: string;
};

export type SearchInputRow = {
    SeedRowNumber: string;
    DeployRowNumber: string;
    TenantId: string;
    APIKey: string;
    Reference: string;
    FormUrl: string;
    FormId: string;
    FormIdsCsv: string;
    SearchPayloadJson: string;
    ExpectedContainsCsv: string;
};

export type AobCompletionResult = {
    tenantId: string;
    apiKey: string;
    reference: string;
    formUrl: string;
    formId: string;
    patient: {
        name: string;
        dob: string;
    };
};

export type DobValidationPath =
    | 'first_attempt'
    | 'second_attempt'
    | 'third_attempt';

export type FormCompletionPath = 'download' | 'no_download' | 'decline';

export type VuContext = {
    vars?: Record<string, unknown>;
};

export type Events = {
    emit: (eventType: string, name: string | number, value?: number) => void;
};
