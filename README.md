# RentCafe Scraper

Extract listing data from RentCafe pages in a structured dataset. Collect core property information such as rent ranges, bedroom and bathroom ranges, area, availability signals, and listing links. This scraper is built for market research, lead generation, and rental inventory monitoring.

## Features

- **Flexible URL support** — Works with RentCafe listing and search page URL patterns.
- **Automatic context discovery** — Detects API context from page/network responses without manual token input.
- **Rich property coverage** — Capture pricing ranges, bedroom and bathroom ranges, area, and listing metadata.
- **Clean dataset output** — Saves records without null-only fields for easier downstream use.
- **Deduplicated records** — Removes duplicates across captured listing payloads.
- **Proxy-ready runs** — Supports proxy configuration for stable production scraping.

## Use Cases

### Rental Market Research
Track apartment inventory and pricing by city to understand market positioning and rent distribution.

### Lead List Building
Build structured property datasets with URLs, addresses, and contact-ready metadata.

### Competitor Monitoring
Monitor listing updates and compare available inventory ranges across target markets.

### Data Pipelines
Feed clean listing records into dashboards, spreadsheets, and automation workflows.

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `startUrl` | String | No | `https://www.rentcafe.com/apartments-for-rent/new-york-city-ny/` | Main RentCafe URL to scrape. |
| `url` | String | No | — | Optional alias for `startUrl`. |
| `results_wanted` | Integer | No | `20` | Maximum number of records to save. |
| `max_pages` | Integer | No | `1` | Safety cap for pagination attempts. |
| `proxyConfiguration` | Object | No | Apify Proxy Residential | Proxy settings for reliability. |

---

## Output Data

Each dataset item can include:

| Field | Type | Description |
|-------|------|-------------|
| `property_name` | String | Name of the apartment property. |
| `property_id` | Number | Property identifier when available. |
| `property_code` | String | Property code when available. |
| `address` | String | Street address. |
| `city` | String | City of the listing. |
| `state` | String | State of the listing. |
| `zip_code` | String | Postal code. |
| `full_address` | String | Combined address value. |
| `site_url` | String | Property site URL. |
| `detail_url` | String | Property details URL. |
| `phone` | String | Contact phone if available. |
| `latitude` | Number | Latitude coordinate. |
| `longitude` | Number | Longitude coordinate. |
| `min_bedrooms` | Number | Minimum listed bedrooms. |
| `max_bedrooms` | Number | Maximum listed bedrooms. |
| `min_bathrooms` | Number | Minimum listed bathrooms. |
| `max_bathrooms` | Number | Maximum listed bathrooms. |
| `min_rent` | Number | Minimum listed rent. |
| `max_rent` | Number | Maximum listed rent. |
| `min_area_sqft` | Number | Minimum listed area in sqft. |
| `max_area_sqft` | Number | Maximum listed area in sqft. |
| `available_units_count` | Number | Availability or waitlist count when present. |
| `amenities` | Array | Amenities list when available. |
| `image_url` | String | Listing image URL. |
| `specials_available` | Boolean | Special offers flag when available. |
| `is_fully_occupied` | Boolean | Occupancy signal when available. |
| `featured_property` | Boolean | Featured listing signal when available. |
| `source_page_url` | String | Page URL where the data was captured. |
| `source_api_url` | String | Source response URL for captured data. |
| `scraped_at` | String | ISO timestamp when the record was extracted. |

---

## Usage Examples

### Basic Run

```json
{
	"startUrl": "https://www.rentcafe.com/apartments-for-rent/new-york-city-ny/",
	"results_wanted": 20
}
```

### Different RentCafe URL Type

```json
{
	"startUrl": "https://www.rentcafe.com/houses-for-rent/us/ca/san-diego/",
	"results_wanted": 40,
	"max_pages": 2
}
```

### Alias URL Field

```json
{
	"url": "https://www.rentcafe.com/apartments-for-rent/chicago-il/",
	"results_wanted": 25,
	"max_pages": 2
}
```

## Sample Output

```json
{
	"property_name": "Example Towers",
	"property_id": 123456,
	"property_code": "p000123",
	"address": "100 Example Ave",
	"city": "New York",
	"state": "NY",
	"zip_code": "10001",
	"full_address": "100 Example Ave, New York, NY, 10001",
	"site_url": "https://www.exampletowers.com/",
	"detail_url": "https://www.rentcafe.com/apartments-for-rent/example-towers/",
	"min_bedrooms": 1,
	"max_bedrooms": 3,
	"min_bathrooms": 1,
	"max_bathrooms": 2,
	"min_rent": 2450,
	"max_rent": 4290,
	"min_area_sqft": 620,
	"max_area_sqft": 1380,
	"available_units_count": 12,
	"source_page_url": "https://www.rentcafe.com/apartments-for-rent/new-york-city-ny/",
	"source_api_url": "https://api.example.com/search",
	"scraped_at": "2026-03-28T10:30:22.119Z"
}
```

## Tips for Best Results

### Use Stable Listing URLs
- Use valid city listing URLs from RentCafe.
- Start with one URL, then scale to multiple URLs.

### Keep QA-Sized Runs Fast
- Use `results_wanted: 20` for quick verification runs.
- Increase record count for production jobs as needed.

### Prefer Residential Proxies
- Residential proxies improve reliability on protected targets.
- Keep default proxy settings for stable cloud runs.

## Integrations

Connect extracted data with:

- **Google Sheets** — Share rental datasets with teams.
- **Airtable** — Build searchable inventory tables.
- **Make** — Trigger downstream workflows.
- **Zapier** — Send listing updates to business apps.
- **Webhooks** — Push results to custom endpoints.

### Export Formats

- **JSON** — Best for APIs and automation.
- **CSV** — Ideal for spreadsheet analysis.
- **Excel** — Business reporting and sharing.
- **XML** — Legacy workflow compatibility.

## Frequently Asked Questions

### Why is the dataset empty?
This usually means the source did not return listing data for your run settings. Confirm URL validity and use residential proxy settings.

### Do I need to provide an API token?
No. The actor discovers API context automatically from page and network data.

### How many records can I collect?
You can increase `results_wanted` as needed, depending on source availability.

### Does the actor remove null values?
Yes. Output records are saved with null and empty fields removed.

## Support

For issues or feature requests, open a discussion in your Apify actor management workflow.

### Resources

- [Apify Documentation](https://docs.apify.com/)
- [Apify API Reference](https://docs.apify.com/api/v2)
- [Schedules](https://docs.apify.com/platform/schedules)

## Legal Notice

This actor is intended for legitimate data collection and analytics workflows. You are responsible for complying with applicable laws, website terms, and data usage policies.