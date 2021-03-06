import { useState, useEffect } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { useApi } from '../hooks/api';

export const useUser = () => {
    const { user, isAuthenticated } = useAuth0();
    const { apiGet } = useApi();

    const [isUserLoading, setUserIsLoading] = useState(true)
    const [isUserError, setUserIsError] = useState(false)
    const [userInfo, setUserInfo] = useState(null)
    const [isAdmin, setIsAdmin] = useState(false)
    const [isDeveloper, setIsDeveloper] = useState(false)

    useEffect(() => {

        if (!isAuthenticated)
            return;

        loadUser();
    }, [user, isAuthenticated]);

    const loadUser = () => {

        apiGet(`getLoggedInUser`)
            .then(
                (response) => {
                    var user = response.data;
                    setUserInfo(user);
                    setIsAdmin(user.admin);
                    setIsDeveloper(user.developer);
                    setUserIsLoading(false);
                },
                (fail) => {
                    setUserIsError(true);
                    setUserIsLoading(false);
                }
            );
    }

    const userProfileIsValid = () =>
    {
        if (!userInfo)
            return false;

        return userInfo.given_name && userInfo.family_name && userInfo.phone_number && userInfo.birth_date && userInfo.address_line_1 && userInfo.postal_code && userInfo.city && userInfo.country;
    }

    return { isUserLoading, isUserError, user, isAuthenticated, userInfo, isAdmin, isDeveloper, userProfileIsValid };
};

export default useUser;
