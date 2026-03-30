# API Discovery

## Target
- URL: `https://www.rentcafe.com/apartments-for-rent/new-york-city-ny/`
- Date verified: `2026-03-28`

## Existing Output Audit
- Current actor fields (before this update): `property_name`, `property_id`, `property_code`, `address`, `city`, `state`, `zip_code`, `full_address`, `phone`, `site_url`, `detail_url`, `latitude`, `longitude`, beds/baths/rent/sqft ranges, amenities, image URL, occupancy/special flags, source metadata.
- Missing/weak fields before fix: nested address/image structures from RentCafe inline objects were not normalized well for all records; Cloudflare-blocked API path caused empty runs.

## Candidate Endpoints Tested

### Candidate A (blocked in this environment)
- Endpoint: `POST https://www.rentcafe.com/mapstate/apartments-for-rent/new-york-city-ny/`
- Auth: anti-forgery token + Cloudflare/session cookies required
- Result: `403` Cloudflare challenge response (not reliable locally without favorable IP reputation)
- Notes: same issue observed for `POST /SeoSearch/GetSortedResults/apartments-for-rent/new-york-city-ny/`

### Candidate B (selected, stable)
- Endpoint pattern: `GET https://www.rentcafe.com/apartments-for-rent/<city-state>/`
- Method: `GET`
- Auth: none beyond normal browser request
- Data source in response: embedded script objects
  - `RCILSMapListings.rentals`
  - `ExtraRentalsJson.Rentals`
- Why selected: returns rich listing JSON directly in page HTML and avoids blocked `POST /mapstate` calls.

## Scoring (Skill Rubric)

### Candidate A: `POST /mapstate/...`
- Returns JSON directly: `+30` (when not blocked)
- >15 fields: `+25`
- No auth required: `+0` (token/cookies required)
- Pagination support: `+15`
- Matches/extents current fields: `+10`
- Total: `80` (high potential, but blocked from this environment)

### Candidate B: Embedded listing JSON in page HTML (selected)
- Returns JSON directly: `+30` (JSON objects embedded in response)
- >15 fields: `+25`
- No auth required: `+20`
- Pagination support: `+15` (`?page=` next pages)
- Matches/extends current fields: `+10`
- Total: `100`

## Selected Internal JSON Source
- Request URL: `https://www.rentcafe.com/apartments-for-rent/new-york-city-ny/`
- Request method: `GET`
- Required headers: standard browser headers (`User-Agent`, `Accept`, `Accept-Language`)
- Parse targets:
  - `RCILSMapListings.rentals`
  - `ExtraRentalsJson.Rentals`
- Pagination:
  - append/update `page` query param, e.g. `...?page=2`

## How To Send Request For JSON Data
1. Send `GET` request to the listing page URL.
2. Read HTML response body.
3. Extract script assignment objects:
   - `RCILSMapListings = { rentals: [...] };`
   - `ExtraRentalsJson = {"Rentals":[...], ...};`
4. Parse the embedded arrays and map items to dataset fields.

## Data Coverage
- Property identity: `PropertyId`, `Name`, `PropertyShortName`
- Address/geo: nested `Address`, `Latitude`, `Longitude`
- Pricing/ranges: `PriceValue`, beds/baths/area text ranges
- Media: `CurrentImage.Url`
- Availability context: `NumberOfRentals`, special flags, listing URLs
- Additional metadata: company, listing type, source markers

