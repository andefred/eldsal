import React from "react";
import { useAuth0 } from "@auth0/auth0-react";
import Button from "reactstrap/lib/Button";
import SiteHeader from "../Common/SiteHeader";
import logo from "../../images/eldsal-logo.svg";

const SubscriptionPage = () => {

    const { user, isAuthenticated } = useAuth0();

    if (!isAuthenticated) {
        return <div />;
    }

    return (
        <div className="App">
            <SiteHeader />
            <h1>Subscription</h1>
            <p>Here the user may manage the membership subscriptions for membership fee and house access fee.</p>
        </div>
    );
};

export default SubscriptionPage;